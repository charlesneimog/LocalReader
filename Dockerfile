FROM python:3.12-slim

WORKDIR /app

COPY app.py ./
COPY server.py ./

# Web UI
COPY index.html ./
COPY manifest.webmanifest ./
COPY sw.js ./
COPY threads.js ./
COPY assets ./assets
COPY src ./src
COPY thirdparty ./thirdparty

RUN pip install --no-cache-dir  googletrans==4.0.2

VOLUME ["/app/data"]

EXPOSE 8000

CMD ["python", "server.py"]
