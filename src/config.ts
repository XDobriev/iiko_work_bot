import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

export interface Config {
  gemini: {
    apiKey: string;
    model: string;
    models: string[];
    photoModels: string[];
    voiceModels: string[];
    complexModels: string[];
    timeoutMs: number;
    stalledTimeoutMs: number;
    pingTimeoutMs: number;
  };
  telegram: {
    token: string;
    allowedUserIds: number[];
  };
  iiko: {
    url: string;
    login: string;
    password?: string;
  };
  db: {
    path: string;
  };
  webapp: {
    enabled: boolean;
    port: number;
    url: string;
  };
}

const parseAllowedUserIds = (raw?: string): number[] => {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(id => !isNaN(id));
};

const parseModelList = (rawModels?: string, primary?: string, fallbackList?: string[]): string[] => {
  const result: string[] = [];
  if (primary && primary.trim()) {
    result.push(primary.trim());
  }

  if (rawModels && rawModels.trim()) {
    const list = rawModels.split(',').map(m => m.trim()).filter(Boolean);
    for (const m of list) {
      if (!result.includes(m)) {
        result.push(m);
      }
    }
  } else {
    const fallback = fallbackList || ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3-flash-preview'];
    for (const m of fallback) {
      if (!result.includes(m)) {
        result.push(m);
      }
    }
  }

  return result;
};

const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const generalModels = parseModelList(process.env.GEMINI_MODELS, primaryModel);

export const normalizeWebappUrl = (raw?: string): string => {
  if (!raw || !raw.trim()) return '';
  let url = raw.trim().replace(/\/+$/, '');
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  return url;
};

export const config: Config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: primaryModel,
    models: generalModels,
    photoModels: parseModelList(process.env.GEMINI_MODELS_PHOTO, undefined, [primaryModel, ...generalModels]),
    voiceModels: parseModelList(process.env.GEMINI_MODELS_VOICE, undefined, ['gemini-3.5-transcribe', 'gemini-3.5-flash-lite', 'gemini-3.5-flash']),
    complexModels: parseModelList(process.env.GEMINI_MODELS_COMPLEX, undefined, ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite']),
    timeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS || '120000', 10) || 120000,
    stalledTimeoutMs: parseInt(process.env.GEMINI_STALLED_TIMEOUT_MS || '25000', 10) || 25000,
    pingTimeoutMs: parseInt(process.env.GEMINI_PING_TIMEOUT_MS || '35000', 10) || 35000
  },
  telegram: {
    token: process.env.TELEGRAM_TOKEN || '',
    allowedUserIds: parseAllowedUserIds(process.env.ALLOWED_USER_IDS)
  },
  iiko: {
    url: (process.env.IIKO_URL || 'https://beyni.iikoweb.ru').replace(/\/+$/, ''),
    login: process.env.IIKO_LOGIN || '',
    password: process.env.IIKO_PASSWORD || ''
  },
  db: {
    path: path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/invoices.db')
  },
  webapp: {
    enabled: process.env.WEBAPP_ENABLED !== 'false',
    port: parseInt(process.env.WEBAPP_PORT || process.env.PORT || '3000', 10) || 3000,
    url: normalizeWebappUrl(process.env.WEBAPP_URL || 'https://iiko-bot-khamzatd.mia0.amvera.tech')
  }
};
