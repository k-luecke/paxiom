export async function readJsonBody(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.length ? JSON.parse(text) : {});
      } catch (e) {
        reject(new Error(`invalid json: ${e.message}`));
      }
    });
  });
}

export function sendJson(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
    ...headers,
  });
  res.end(buf);
}

export function methodNotAllowed(res, methods) {
  res.writeHead(405, { Allow: methods.join(', ') });
  res.end();
}

export function notFound(res) {
  res.writeHead(404);
  res.end();
}
