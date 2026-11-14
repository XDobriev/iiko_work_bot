import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvoiceWorkflow } from '../workflow/invoice-workflow.js';
import { InvoiceDataSchema } from '../types/index.js';

export interface WebAppServerInstance {
  server: http.Server;
  port: number;
  stop: () => Promise<void>;
}

function resolveHtmlPath(): string | null {
  // Check next to current file
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const p1 = path.join(currentDir, 'index.html');
    if (fs.existsSync(p1)) return p1;
  } catch {}

  // Check in src/webapp
  const p2 = path.resolve(process.cwd(), 'src', 'webapp', 'index.html');
  if (fs.existsSync(p2)) return p2;

  // Check in dist/webapp
  const p3 = path.resolve(process.cwd(), 'dist', 'webapp', 'index.html');
  if (fs.existsSync(p3)) return p3;

  return null;
}

export function startWebAppServer(workflow: InvoiceWorkflow, port = 3000): WebAppServerInstance {
  const htmlPath = resolveHtmlPath();

  const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. Health check
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    // 2. Serve Mini App HTML
    if (pathname === '/' || pathname === '/webapp' || pathname === '/index.html') {
      if (htmlPath && fs.existsSync(htmlPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(htmlPath).pipe(res);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Шаблон Telegram Mini App не найден на диске.');
      }
      return;
    }

    // 3. GET /api/invoice/:id
    const invoiceMatch = pathname.match(/^\/api\/invoice\/(\d+)$/);
    if (invoiceMatch && req.method === 'GET') {
      const invoiceId = parseInt(invoiceMatch[1], 10);
      const card = workflow.getInvoiceCard(invoiceId);
      if (!card) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Накладная не найдена' }));
        return;
      }

      const repo = workflow.getRepo();
      const knownItems = repo.getKnownItems(80);
      const suppliers = repo.getKnownSuppliers(40);
      const mappings = repo.getAllProductMappings();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        invoiceId,
        data: card.domain.data,
        comparison: card.comparison,
        knownItems,
        suppliers,
        mappings
      }));
      return;
    }

    // 4. POST /api/invoice/:id
    if (invoiceMatch && req.method === 'POST') {
      const invoiceId = parseInt(invoiceMatch[1], 10);
      try {
        const bodyText = await readRequestBody(req);
        const json = JSON.parse(bodyText);
        const payloadData = json.data || json;

        const parseResult = InvoiceDataSchema.safeParse(payloadData);
        if (!parseResult.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Ошибка валидации полей накладной',
            errors: parseResult.error.format()
          }));
          return;
        }

        const editRes = workflow.applyDataEdit(invoiceId, parseResult.data);
        if (!editRes.success) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: editRes.message }));
          return;
        }

        // Save optional mappings if provided
        if (Array.isArray(json.mappings)) {
          for (const m of json.mappings) {
            if (m.rawName && m.iikoProductName) {
              workflow.saveProductMapping(m.rawName, m.iikoProductName, m.iikoProductId);
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          message: editRes.message,
          data: editRes.data,
          cardText: editRes.cardText
        }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message || 'Ошибка обработки данных' }));
      }
      return;
    }

    // 5. GET /api/products (autocomplete / catalog)
    if (pathname === '/api/products' && req.method === 'GET') {
      const repo = workflow.getRepo();
      const knownItems = repo.getKnownItems(100);
      const suppliers = repo.getKnownSuppliers(50);
      const mappings = repo.getAllProductMappings();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        knownItems,
        suppliers,
        mappings
      }));
      return;
    }

    // 6. POST /api/mapping
    if (pathname === '/api/mapping' && req.method === 'POST') {
      try {
        const bodyText = await readRequestBody(req);
        const body = JSON.parse(bodyText);
        if (!body.rawName || !body.iikoProductName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Обязательны rawName и iikoProductName' }));
          return;
        }

        workflow.saveProductMapping(body.rawName, body.iikoProductName, body.iikoProductId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message || 'Ошибка сохранения сопоставления' }));
      }
      return;
    }

    // 404 Fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });

  server.listen(port, () => {
    // Listening started
  });

  return {
    server,
    port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      })
  };
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      // Safeguard max 5MB payload
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Размер тела запроса превышает лимит'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
