FROM python:3.12-slim

WORKDIR /app

COPY app.py .
COPY server.py .

VOLUME ["/app/data"]

EXPOSE 8000

CMD ["python", "server.py"]
