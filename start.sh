#!/bin/sh
set -e

# Держим один долгоживущий процесс LibreOffice в фоне (headless, слушает
# сокет 127.0.0.1:2002). Конвертация docx -> pdf (protocolPdf.js, unoconv)
# идёт через уже поднятый процесс — это секунды, а не десятки секунд, которые
# уходят на запуск LibreOffice с нуля на каждый клик «Скачать PDF».
soffice --headless --invisible --nocrashreport --nodefault --nologo \
  --nofirststartwizard --norestore \
  --accept="socket,host=127.0.0.1,port=2002;urp;" \
  -env:UserInstallation=file:///tmp/lo-profile &

# Небольшая пауза, чтобы сокет успел подняться до первого запроса на PDF
# (если он ещё не готов — код в protocolPdf.js всё равно упадёт обратно на
# прямой запуск soffice, просто первый запрос после деплоя будет чуть медленнее).
sleep 4

exec node Server.js
