FROM python:3.12-slim

WORKDIR /app

COPY app.py .
COPY server.py .

VOLUME ["/app/database.db"]

EXPOSE 8000

CMD ["python", "server.py"]