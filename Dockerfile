FROM python:3.12-slim

WORKDIR /app

COPY app.py .
COPY server.py .

RUN pip install --no-cache-dir googletrans==4.0.0-rc1

VOLUME ["/app/data"]

EXPOSE 8000

CMD ["python", "server.py"]
