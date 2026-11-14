import { config } from '../config.js';
import { InvoiceData, InvoiceDataSchema } from '../types/index.js';

export interface RecognizerOptions {
  knownItems?: string[];
  knownItemsWithUnits?: Array<{ name: string; unit?: string }>;
  knownSuppliers?: string[];
}

export const GEMINI_INVOICE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    date: {
      type: 'STRING',
      description: 'Дата накладной в формате ДД.ММ.ГГГГ'
    },
    supplier: {
      type: 'STRING',
      description: 'Название поставщика'
    },
    warehouse: {
      type: 'STRING',
      enum: ['kitchen', 'household'],
      description: 'Склад: kitchen для кухни/продуктов, household для хоз. нужд'
    },
    items: {
      type: 'ARRAY',
      description: 'Список товаров/позиций в накладной',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Наименование товара' },
          qty: { type: 'NUMBER', description: 'Количество' },
          price: { type: 'NUMBER', description: 'Цена за единицу в рублях' },
          sum: { type: 'NUMBER', description: 'Сумма по позиции' },
          unit: { type: 'STRING', description: 'Единица измерения (кг, шт, бан, л, уп)' }
        },
        required: ['name', 'qty', 'price', 'sum']
      }
    },
    total_written: {
      type: 'NUMBER',
      nullable: true,
      description: 'Рукописная сумма ИТОГО внизу чека, либо null'
    },
    notes: {
      type: 'STRING',
      description: 'Примечания или комментарии'
    }
  },
  required: ['date', 'supplier', 'warehouse', 'items']
};

export function detectImageMimeType(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return 'image/jpeg';
}

export class GeminiInvoiceRecognizer {
  private apiKey: string;
  private models: string[];

  constructor(apiKey?: string, models?: string[] | string) {
    this.apiKey = apiKey || config.gemini.apiKey;
    if (Array.isArray(models)) {
      this.models = models.filter(Boolean);
    } else if (typeof models === 'string' && models.trim()) {
      const primary = models.trim();
      this.models = [primary, ...config.gemini.models.filter(m => m !== primary)];
    } else {
      this.models = config.gemini.models;
    }
  }

  getCandidateModels(): string[] {
    return this.models;
  }

  private buildSystemPrompt(options: RecognizerOptions, isVoice = false): string {
    const currentYear = new Date().getFullYear();
    let memoryContext = '';
    if (options.knownSuppliers && options.knownSuppliers.length > 0) {
      memoryContext += `\nИзвестные поставщики ресторана: ${options.knownSuppliers.slice(0, 30).join(', ')}.`;
    }
    if (options.knownItemsWithUnits && options.knownItemsWithUnits.length > 0) {
      const itemsStr = options.knownItemsWithUnits
        .slice(0, 80)
        .map(i => i.unit ? `${i.name} (${i.unit})` : i.name)
        .join(', ');
      memoryContext += `\nИзвестные товары ресторана и их обычные фасовки/тары: ${itemsStr}.`;
    } else if (options.knownItems && options.knownItems.length > 0) {
      memoryContext += `\nИзвестные позиции/товары из предыдущих накладных: ${options.knownItems.slice(0, 80).join(', ')}.`;
    }

    const taskDesc = isVoice
      ? 'Твоя задача — прослушать голосовое сообщение шеф-повара/управляющего ресторана и извлечь данные о закупке (поставщик, товары, количество, цены, склад).'
      : 'Твоя задача — точно извлечь все позиции, цены, количества, суммы, дату, поставщика и склад с фото накладной.';

    return `Ты профессиональный помощник ресторана по распознаванию рукописных накладных и товарных чеков на русском языке.
${taskDesc}
${memoryContext ? memoryContext + '\nИспользуй эти известные названия и тары для сопоставления терминологии ресторана.' : ''}

Правила:
1. "date": дата накладной в формате "ДД.ММ.ГГГГ" (если год не указан, поставь текущий год ${currentYear}).
2. "supplier": название поставщика (например: "Бойня", "Овощи", "ИП Иванов", "Закупка").
3. "warehouse": "kitchen" (Склад Кухня — продукты питания, мясо, овощи, бакалея) или "household" (Хоз склад — моющие средства, перчатки, салфетки, уголь, тряпки, упаковка).
4. "items": массив позиций.
   - "name": понятное наименование товара (на русском языке, без опечаток).
   - "qty": количество (число с плавающей точкой, например 5.3 или 10).
   - "unit": единица измерения: "кг", "г", "шт", "бан", "бут", "уп", "л", "пач", "ящ".
     * Если товар штучный/в таре (например, "Оливки 1 380г", "Масло 1 бут", "Салфетки 5 пачек"), укажи unit: "бан", "бут", "уп" или "шт".
     * Для весовых товаров укажи "кг" или "г".
   - "price": цена за единицу (рублей). Если цена не указана, но есть сумма и кол-во — рассчитай как sum / qty.
   - "sum": итоговая сумма по позиции. Если не указана — qty * price.
5. Перечеркнутые или отмененные позиции НЕ включай!
6. "total_written": числовая итоговая сумма, которая написана внизу накладной от руки (или null, если итог не написан явно).
7. Особенности рукописного текста и частые ошибки:
   - Цифры «1» и «7»: рукописная «1» с длинным наклонным хвостиком часто похожа на «7», а «7» может иметь поперечную черту. Всегда проверяй математику строки: qty * price = sum. Выбирай ту цифру, при которой математическое равенство выполняется.
   - Десятичные разделители: запятая «,» и точка «.» в рукописных количествах и весах часто выглядят как точка, штрих или сливаются (например «4.5» или «4,5» кг). Весовые позиции почти всегда имеют дробный вес.
   - Слитно написанные количество и цена: записи вида «15*580», «15х580», «15 580» или «15шт580» разбивай на количество (15) и цену за единицу (580).
   - Сокращения единиц: «к», «кг» -> «кг»; «г», «гр» -> «г»; «ш», «шт» -> «шт»; «б», «бан» -> «бан»; «у», «уп», «пач» -> «уп»; «бут» -> «бут»; «л» -> «л».
   - Составные формулы: если позиция записана через сомножители тары (например «4*6.5кг 250»), общее количество равно произведению фасовки (26 кг), а 250 — цена за 1 кг.
8. Верни валидный JSON в соответствии с JSON Schema.`;
  }

  private async executeGenerateContent(requestBody: any, isVoice = false): Promise<InvoiceData> {
    const candidateModels = this.getCandidateModels();
    let lastError: any = null;

    for (const model of candidateModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[Gemini] Запрос к ${model} (попытка ${attempt}/2)...`);
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': this.apiKey
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(25000)
          });

          if (!response.ok) {
            const errText = await response.text();
            console.warn(`[Gemini] Модель ${model} вернула HTTP ${response.status}: ${errText.slice(0, 120)}`);
            if (response.status === 503 || response.status === 429 || response.status === 500) {
              lastError = new Error(`Gemini API (${response.status}) на ${model}: ${errText}`);
              if (attempt < 2) {
                console.log(`[Gemini] Пауза 1.5с перед повтором к ${model}...`);
                await new Promise(r => setTimeout(r, 1500));
                continue;
              }
              break;
            }
            throw new Error(`Gemini API error (${response.status}): ${errText}`);
          }

          const json = (await response.json()) as any;
          const candidate = json.candidates?.[0];
          const rawContent = candidate?.content?.parts?.[0]?.text;

          if (!rawContent) {
            throw new Error(isVoice ? 'Нейросеть не смогла распознать голос.' : 'Нейросеть вернула пустой ответ.');
          }

          const cleaned = rawContent
            .trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```$/i, '')
            .trim();

          let parsed: unknown;
          try {
            parsed = JSON.parse(cleaned);
          } catch (jsonErr: any) {
            console.warn(`[Gemini] Ошибка разбора JSON от ${model} (попытка ${attempt}): ${jsonErr.message}`);
            if (attempt < 2) {
              console.log(`[Gemini] Повторный запрос к ${model} из-за ошибки разбора JSON...`);
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            throw new Error(`Некорректный JSON от ${model}: ${jsonErr.message}`);
          }

          const validated = InvoiceDataSchema.parse(parsed);
          console.log(`[Gemini] ✅ Успешно распознано моделью ${model}!`);
          return validated;
        } catch (err: any) {
          lastError = err;
          console.warn(`[Gemini] Ошибка вызова ${model} (попытка ${attempt}): ${err.message}`);
          if (attempt < 2 && (err.name === 'TimeoutError' || err.message?.includes('503') || err.message?.includes('JSON'))) {
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }
          break;
        }
      }
    }

    throw lastError || new Error('Все доступные модели временно перегружены. Пожалуйста, повторите попытку через минуту.');
  }

  /**
   * Recognizes handwritten invoice image buffer via Gemini Vision.
   */
  async recognize(imageBuffer: Buffer, options: RecognizerOptions = {}, mimeType?: string): Promise<InvoiceData> {
    const base64Image = imageBuffer.toString('base64');
    const systemPrompt = this.buildSystemPrompt(options, false);
    const resolvedMime = mimeType || detectImageMimeType(imageBuffer);

    const requestBody = {
      contents: [
        {
          parts: [
            { text: systemPrompt },
            {
              inline_data: {
                mime_type: resolvedMime,
                data: base64Image
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_INVOICE_RESPONSE_SCHEMA
      }
    };

    return this.executeGenerateContent(requestBody, false);
  }

  /**
   * Recognizes voice/audio messages where chefs verbally dictate deliveries.
   */
  async recognizeVoice(audioBuffer: Buffer, mimeType = 'audio/ogg', options: RecognizerOptions = {}): Promise<InvoiceData> {
    const base64Audio = audioBuffer.toString('base64');
    const systemPrompt = this.buildSystemPrompt(options, true);

    const requestBody = {
      contents: [
        {
          parts: [
            { text: systemPrompt },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Audio
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_INVOICE_RESPONSE_SCHEMA
      }
    };

    return this.executeGenerateContent(requestBody, true);
  }
}
