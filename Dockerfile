FROM node:18-alpine

RUN apk add --no-cache ghostscript ghostscript-fonts ttf-dejavu fontconfig

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
