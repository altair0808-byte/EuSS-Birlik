# Образ для Render (или любого другого Docker-хостинга).
# Нужен именно Docker, а не «нативный» Node-рантайм Render — там нет доступа
# к apt-get/системным пакетам, а LibreOffice — это системный пакет, не npm.

FROM node:20-bookworm-slim

# libreoffice-writer — достаточно (только конвертация .docx -> .pdf, не нужен
# полный офисный пакет с Calc/Impress — это ощутимо экономит время сборки и
# размер образа). Шрифты — чтобы кириллица в PDF не превращалась в кракозябры.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      fonts-dejavu \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Render сам передаёт правильный PORT через переменную окружения — Server.js
# уже её читает (process.env.PORT), ничего дополнительно указывать не нужно.

CMD ["node", "Server.js"]
