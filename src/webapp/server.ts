import http from 'node:http';
import { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { InvoiceWorkflow } from '../workflow/invoice-workflow.js';
import { InvoiceDataSchema } from '../types/index.js';
import { ProductCatalogMatcher } from '../iiko/matcher.js';

export interface TelegramAuthValidationResult {
  isValid: boolean;
  user?: any;
  authDate?: number;
  error?: string;
}

/**
 * Validates Telegram WebApp initData HMAC-SHA256 signature against botToken.
 * Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86400
): TelegramAuthValidationResult {
  if (!initData || typeof initData !== 'string') {
    return { isValid: false, error: 'initData is empty' };
  }
  if (!botToken) {
    return { isValid: false, error: 'botToken is required for validation' };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) {
      return { isValid: false, error: 'hash parameter missing' };
    }

    // Check auth_date is required per Telegram WebApp specification
    const authDateStr = params.get('auth_date');
    if (!authDateStr) {
      return { isValid: false, error: 'auth_date parameter missing' };
    }
    const authDate = parseInt(authDateStr, 10);
    if (isNaN(authDate)) {
      return { isValid: false, error: 'invalid auth_date parameter' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (maxAgeSeconds > 0 && (now - authDate > maxAgeSeconds || authDate > now + 300)) {
      return { isValid: false, error: 'initData has expired' };
    }

    // Sort all keys except hash alphabetically
    const entries: Array<[string, string]> = [];
    params.forEach((value, key) => {
      if (key !== 'hash') {
        entries.push([key, value]);
      }
    });

    entries.sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    // Secret key = HMAC_SHA256("WebAppData", botToken)
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const calculatedBuffer = Buffer.from(calculatedHash, 'hex');
    const hashBuffer = Buffer.from(hash, 'hex');

    if (calculatedBuffer.length !== hashBuffer.length || !crypto.timingSafeEqual(calculatedBuffer, hashBuffer)) {
      return { isValid: false, error: 'Invalid HMAC signature' };
    }

    let user: any;
    const userStr = params.get('user');
    if (userStr) {
      try {
        user = JSON.parse(userStr);
      } catch {}
    }

    return {
      isValid: true,
      user,
      authDate: authDateStr ? parseInt(authDateStr, 10) : undefined
    };
  } catch (err: any) {
    return { isValid: false, error: err.message || 'Validation error' };
  }
}

export function extractTelegramInitData(req: http.IncomingMessage, parsedUrl: URL): string | null {
  // 1. Authorization header: "tma <initData>" or "Bearer <initData>" or "<initData>"
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('tma ')) {
      return trimmed.slice(4).trim();
    }
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      return trimmed.slice(7).trim();
    }
    if (trimmed.includes('hash=')) {
      return trimmed;
    }
  }

  // 2. Custom header
  const customHeader = req.headers['x-telegram-init-data'];
  if (typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim();
  }

  // 3. Query param
  const queryInitData = parsedUrl.searchParams.get('initData');
  if (queryInitData) {
    return queryInitData.trim();
  }

  return null;
}

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

export interface WebAppServerOptions {
  onInvoiceUpdated?: (invoiceId: number, cardText: string, hasPhoto: boolean) => Promise<void> | void;
  botToken?: string;
  requireAuth?: boolean;
  allowedUserIds?: number[];
}

export function startWebAppServer(
  workflow: InvoiceWorkflow,
  port = 3000,
  options?: WebAppServerOptions
): WebAppServerInstance {
  const htmlPath = resolveHtmlPath();

  const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Telegram-Init-Data');

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

    // 2.1. Authentication middleware for /api/* endpoints
    if (pathname.startsWith('/api/')) {
      const botToken = options?.botToken || config.telegram.token;
      const requireAuth = options?.requireAuth ?? false;
      const initData = extractTelegramInitData(req, parsedUrl);

      if (requireAuth || initData) {
        if (!initData) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: 'Необходима авторизация Telegram WebApp (отсутствует initData)' }));
          return;
        }

        const authResult = validateTelegramInitData(initData, botToken);
        if (!authResult.isValid) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, message: `Ошибка авторизации Telegram WebApp: ${authResult.error || 'неверная подпись'}` }));
          return;
        }

        const allowedIds = options?.allowedUserIds !== undefined ? options.allowedUserIds : config.telegram.allowedUserIds;
        if (allowedIds.length > 0) {
          const userId = authResult.user?.id;
          if (!userId || !allowedIds.includes(userId)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, message: 'Доступ ограничен: пользователь не входит в список разрешенных' }));
            return;
          }
        }
      }
    }

    const repo = workflow.getRepo();

    // 3. GET /api/invoice/latest
    if (pathname === '/api/invoice/latest' && req.method === 'GET') {
      const latestDomain = workflow.getLatestInvoice('pending') || workflow.getLatestInvoice();
      if (!latestDomain) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'В базе пока нет накладных' }));
        return;
      }

      const invoiceId = latestDomain.invoice.id;
      const card = workflow.getInvoiceCard(invoiceId);
      if (!card) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Накладная не найдена' }));
        return;
      }

      const knownItems = repo.getKnownItems(80);
      const suppliers = repo.getKnownSuppliers(40);
      const mappings = repo.getAllProductMappings();
      const recentInvoices = workflow.getRecentInvoicesWithData(15);
      const catalogProducts = await workflow.getCatalogProducts();
      const matcherAnalysis = await workflow.getInvoiceMatcherAnalysis(invoiceId);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        invoiceId,
        data: card.domain.data,
        comparison: card.comparison,
        knownItems,
        suppliers,
        mappings,
        recentInvoices,
        catalogProducts,
        matcherAnalysis
      }));
      return;
    }

    // 4. GET /api/invoices/recent
    if (pathname === '/api/invoices/recent' && req.method === 'GET') {
      const recentInvoices = workflow.getRecentInvoicesWithData(20);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, invoices: recentInvoices }));
      return;
    }

    // 5. GET /api/invoice/:id
    const invoiceMatch = pathname.match(/^\/api\/invoice\/(\d+)$/);
    if (invoiceMatch && req.method === 'GET') {
      const invoiceId = parseInt(invoiceMatch[1], 10);
      const card = workflow.getInvoiceCard(invoiceId);
      if (!card) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Накладная не найдена' }));
        return;
      }

      const knownItems = repo.getKnownItems(80);
      const suppliers = repo.getKnownSuppliers(40);
      const mappings = repo.getAllProductMappings();
      const recentInvoices = workflow.getRecentInvoicesWithData(15);
      const catalogProducts = await workflow.getCatalogProducts();
      const matcherAnalysis = await workflow.getInvoiceMatcherAnalysis(invoiceId);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        invoiceId,
        data: card.domain.data,
        comparison: card.comparison,
        knownItems,
        suppliers,
        mappings,
        recentInvoices,
        catalogProducts,
        matcherAnalysis
      }));
      return;
    }

    // 5.1. GET /api/match-item (dynamic matching for query)
    if (pathname === '/api/match-item' && req.method === 'GET') {
      const name = parsedUrl.searchParams.get('name') || '';
      const unit = parsedUrl.searchParams.get('unit') || undefined;
      const explicit = parsedUrl.searchParams.get('explicit') || undefined;

      const products = await workflow.getCatalogProducts();
      const matcher = new ProductCatalogMatcher(products, workflow.getRepo());
      const analysis = matcher.analyzeItem(name, unit, explicit);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, analysis }));
      return;
    }

    // 6. POST /api/invoice/:id
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

        // Save mappings (honor explicit client mappings array if provided, e.g. checkbox selections)
        if (Array.isArray(json.mappings)) {
          for (const m of json.mappings) {
            if (m.rawName && m.iikoProductName) {
              workflow.saveProductMapping(m.rawName, m.iikoProductName, m.iikoProductId);
            }
          }
        } else {
          for (const item of parseResult.data.items) {
            if (item.name && item.iiko_product_name) {
              workflow.saveProductMapping(item.name, item.iiko_product_name, item.iiko_product_id);
            }
          }
        }

        // Trigger bot card update if registered
        if (options?.onInvoiceUpdated) {
          try {
            await options.onInvoiceUpdated(invoiceId, editRes.cardText || '', !!editRes.hasPhoto);
          } catch (updateErr) {
            console.warn('[WebApp] Ошибка при обновлении карточки в Telegram:', updateErr);
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
      const catalogProducts = await workflow.getCatalogProducts();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        catalogProducts,
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

  const host = process.env.HOST || '0.0.0.0';
  if (port === 0) {
    server.listen(0, () => {
      // Listening on OS ephemeral port
    });
  } else {
    server.listen(port, host, () => {
      // Listening on 0.0.0.0
    });
  }

  return {
    server,
    get port(): number {
      const addr = server.address() as AddressInfo | null;
      return addr?.port ?? port;
    },
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
