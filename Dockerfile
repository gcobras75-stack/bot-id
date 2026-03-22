FROM node:20-slim

# Instalar fuentes del sistema para renderizado SVG→PNG con sharp/librsvg
RUN apt-get update && apt-get install -y \
    fontconfig \
    fonts-liberation \
    fonts-dejavu-core \
    --no-install-recommends \
  && fc-cache -fv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["node", "index.js"]
