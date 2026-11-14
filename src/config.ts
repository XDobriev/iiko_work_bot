import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

export interface Config {
  gemini: {
    apiKey: string;
    model: string;
    models: string[];
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

const parseModelList = (rawModels?: string, primary?: string): string[] => {
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
    const fallback = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash'];
    for (const m of fallback) {
      if (!result.includes(m)) {
        result.push(m);
      }
    }
  }

  return result;
};

const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

export const config: Config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: primaryModel,
    models: parseModelList(process.env.GEMINI_MODELS, primaryModel)
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
    url: (process.env.WEBAPP_URL || '').replace(/\/+$/, '')
  }
};
