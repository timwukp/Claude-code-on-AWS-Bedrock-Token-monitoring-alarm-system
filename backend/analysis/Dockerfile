# Fargate ETL image: compacts raw Bedrock invocation-log JSON into partitioned Parquet and
# generates compliance reports. Long-running/batch work that doesn't fit Lambda's limits.
FROM python:3.12-slim@sha256:12316debbfb86890f6b2d825820612741ba527ad5a44e3902759141d572bfe8f

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY etl.py .

# The ECS task definition supplies RAW_LOG_BUCKET / CURATED_BUCKET via environment.
ENTRYPOINT ["python", "etl.py"]
