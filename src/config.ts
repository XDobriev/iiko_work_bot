import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

export interface Config {
  gemini: {
    apiKey: string;
    model: string;
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
}

const parseAllowedUserIds = (raw?: string): number[] => {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(id => !isNaN(id));
};

export const config: Config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash'
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
  }
};
