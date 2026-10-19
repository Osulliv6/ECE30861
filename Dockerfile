# One container for the UI, API, engine (Node) and document parser (Python).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY accessibility-parser/requirements.txt accessibility-parser/requirements.txt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r accessibility-parser/requirements.txt

COPY package.json server.mjs ./
COPY engine engine
COPY frontend frontend
COPY accessibility-parser/integration.mjs accessibility-parser/integration.mjs
COPY accessibility-parser/parser accessibility-parser/parser
# The tester service uploads these fixture documents to the target system.
COPY testing testing
COPY tests/fixtures/documents tests/fixtures/documents

# HOST=0.0.0.0 accepts outside connections; hosts like Render/Railway/Fly set PORT and terminate HTTPS.
ENV HOST=0.0.0.0 PORT=8080 PYTHON=/opt/venv/bin/python PYTHONDONTWRITEBYTECODE=1
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
