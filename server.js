const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// ---------- Config ----------
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '2', 10);
const GS_TIMEOUT_MS = parseInt(process.env.GS_TIMEOUT_MS || '120000', 10);
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '50', 10);
const FILE_TTL_MS = 5 * 60 * 1000;
const uploadDir = '/tmp/uploads';
const outputDir = '/tmp/output';

[uploadDir, outputDir].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ---------- Crash guards ----------
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- Helpers ----------
const safeUnlink = (p) => { try { fs.existsSync(p) && fs.unlinkSync(p); } catch {} };

const sanitize = (name) =>
  name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);

const uniqueId = () =>
  Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');

// ---------- Periodic /tmp cleanup ----------
setInterval(() => {
  const now = Date.now();
  [uploadDir, outputDir].forEach(dir => {
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          if (now - st.mtimeMs > FILE_TTL_MS) safeUnlink(p);
        } catch {}
      }
    } catch {}
  });
}, 60 * 1000);

// ---------- Concurrency queue ----------
let active = 0;
const waiting = [];
const acquire = () => new Promise(resolve => {
  if (active < MAX_CONCURRENT) { active++; return resolve(); }
  waiting.push(resolve);
});
const release = () => {
  active--;
  const next = waiting.shift();
  if (next) { active++; next(); }
};

// ---------- Multer ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, uniqueId() + '-' + sanitize(file.originalname)),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.eps' || ext === '.ai') cb(null, true);
    else cb(new Error('Only EPS and AI files allowed'));
  },
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

// ---------- Routes ----------
app.get('/', (req, res) =>
  res.json({ message: 'EPS to PNG Converter', version: '3.0.0', active, waiting: waiting.length })
);
app.get('/health', (req, res) =>
  res.json({ status: 'OK', active, waiting: waiting.length, ts: new Date().toISOString() })
);

app.post('/convert', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const inputPath = req.file.path;
  const outputPath = path.join(outputDir, path.parse(req.file.filename).name + '.png');
  const dpi = Math.min(Math.max(parseInt(req.body.quality) || 150, 72), 200);

  await acquire();
  let released = false;
  const doRelease = () => { if (!released) { released = true; release(); } };

  let child;
  req.on('close', () => {
    if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
  });

  console.log(`[convert] ${req.file.originalname} dpi=${dpi} active=${active} q=${waiting.length}`);

  const args = [
    '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-dEPSCrop',
    '-sDEVICE=png16m',
    '-dMaxBitmap=30000000',
    '-dBufferSpace=30000000',
    '-dGraphicsAlphaBits=4', '-dTextAlphaBits=4',
    `-r${dpi}`,
    `-sOutputFile=${outputPath}`,
    inputPath,
  ];

  child = execFile('gs', args, { timeout: GS_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, killSignal: 'SIGKILL' },
    (err, stdout, stderr) => {
      safeUnlink(inputPath);

      if (err || !fs.existsSync(outputPath)) {
        doRelease();
        const msg = err?.killed ? 'Conversion timed out' :
                    err?.code === 'ENOENT' ? 'Ghostscript not installed' :
                    'Conversion failed';
        console.error('[convert] FAIL:', req.file.originalname, '-', stderr?.slice(0, 500) || err?.message);
        if (!res.headersSent) res.status(500).json({ error: msg });
        safeUnlink(outputPath);
        return;
      }

      console.log('[convert] OK:', outputPath);

      res.download(outputPath, path.parse(req.file.originalname).name + '.png', (dlErr) => {
        if (dlErr) console.warn('[download] err:', dlErr.message);
        safeUnlink(outputPath);
        doRelease();
      });
    }
  );
});

// ---------- Error middleware ----------
app.use((err, req, res, next) => {
  if (req.file) safeUnlink(req.file.path);
  if (err instanceof multer.MulterError)
    return res.status(400).json({ error: err.message });
  return res.status(400).json({ error: err?.message || 'Bad request' });
});

// ---------- Server with proper timeouts ----------
const server = app.listen(PORT, '0.0.0.0', () =>
  console.log(`Server running on ${PORT}, max concurrent: ${MAX_CONCURRENT}`)
);
server.requestTimeout = 0;
server.headersTimeout = 130000;
server.keepAliveTimeout = 125000;
