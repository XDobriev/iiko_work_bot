import { config } from '../config.js';
import { InvoiceData, InvoiceDataSchema } from '../types/index.js';
import { classifyInvoiceItems } from '../workflow/warehouse-classifier.js';
import { GeminiAutopilot } from './autopilot.js';

export type RecognizerTask = 'photo' | 'voice' | 'complex' | 'general';

export interface RecognizerModelOptions {
  models?: string[];
  photoModels?: string[];
  voiceModels?: string[];
  complexModels?: string[];
}

export interface RecognizerOptions {
  task?: RecognizerTask;
  knownItems?: string[];
  knownItemsWithUnits?: Array<{ name: string; unit?: string }>;
  knownSuppliers?: string[];
  escalateOnDiscrepancy?: boolean;
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
      description: 'Общий склад: kitchen для кухни/продуктов, household для хоз. нужд'
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
          unit: { type: 'STRING', description: 'Единица измерения (кг, шт, бан, л, уп)' },
          warehouse: {
            type: 'STRING',
            enum: ['kitchen', 'household'],
            description: 'Склад позиции: kitchen для кухни/еды/продуктов или household для хозтоваров (перчатки, салфетки, моющие, губки, фольга, контейнеры, уголь)'
          }
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

export const GEMINI_EDIT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: {
      type: 'STRING',
      description: 'Краткое понятное описание примененных правок на русском языке (например: "Изменена цена помидоров на 180 ₽, удалена строка 2")'
    },
    data: GEMINI_INVOICE_RESPONSE_SCHEMA
  },
  required: ['summary', 'data']
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
  private hasExplicitModels: boolean = false;
  private models: string[];
  private photoModels: string[];
  private voiceModels: string[];
  private complexModels: string[];
  private autopilot?: GeminiAutopilot;

  constructor(
    apiKey?: string,
    models?: string[] | string | RecognizerModelOptions,
    autopilot?: GeminiAutopilot
  ) {
    this.apiKey = apiKey || config.gemini.apiKey;
    this.autopilot = autopilot || GeminiAutopilot.getInstance();

    if (Array.isArray(models)) {
      this.hasExplicitModels = true;
      this.models = models.filter(Boolean);
      this.photoModels = [...this.models];
      this.voiceModels = [...this.models];
      this.complexModels = [...this.models];
    } else if (typeof models === 'string' && models.trim()) {
      this.hasExplicitModels = true;
      const primary = models.trim();
      this.models = [primary, ...config.gemini.models.filter(m => m !== primary)];
      this.photoModels = [...this.models];
      this.voiceModels = [...this.models];
      this.complexModels = [...this.models];
    } else if (models && typeof models === 'object') {
      this.hasExplicitModels = true;
      this.models = models.models && models.models.length > 0 ? models.models : config.gemini.models;
      this.photoModels = models.photoModels && models.photoModels.length > 0 ? models.photoModels : config.gemini.photoModels;
      this.voiceModels = models.voiceModels && models.voiceModels.length > 0 ? models.voiceModels : config.gemini.voiceModels;
      this.complexModels = models.complexModels && models.complexModels.length > 0 ? models.complexModels : config.gemini.complexModels;
    } else {
      this.hasExplicitModels = false;
      this.models = config.gemini.models;
      this.photoModels = config.gemini.photoModels;
      this.voiceModels = config.gemini.voiceModels;
      this.complexModels = config.gemini.complexModels;
    }
  }

  getCandidateModels(task?: RecognizerTask): string[] {
    if (!this.hasExplicitModels && this.autopilot) {
      const active = this.autopilot.getActiveModels(task || 'general');
      if (active && active.length > 0) {
        return active;
      }
    }

    if (task === 'voice') return this.voiceModels;
    if (task === 'complex') return this.complexModels;
    if (task === 'photo') return this.photoModels;
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
   - "warehouse": обязательно определи категорию/склад для каждой позиции: "kitchen" (кухня/еда/продукты) или "household" (хозтовары, моющие, перчатки, салфетки, губки, фольга, контейнеры, пакеты, уголь).
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

  private async executeGenerateContent(
    requestBody: any,
    isVoice = false,
    modelsList?: string[]
  ): Promise<InvoiceData> {
    const candidateModels = modelsList && modelsList.length > 0
      ? modelsList
      : this.getCandidateModels(isVoice ? 'voice' : 'photo');
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
          validated.items = classifyInvoiceItems(validated.items, validated.warehouse);
          validated.model_used = model;
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

  private async executeEditGenerateContent(
    requestBody: any,
    task: RecognizerTask = 'general'
  ): Promise<{ data: InvoiceData; summary: string }> {
    const candidateModels = this.getCandidateModels(task);
    let lastError: any = null;

    for (const model of candidateModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[Gemini Edit] Запрос к ${model} (попытка ${attempt}/2)...`);
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
            console.warn(`[Gemini Edit] ${model} HTTP ${response.status}: ${errText.slice(0, 120)}`);
            if (response.status === 503 || response.status === 429 || response.status === 500) {
              lastError = new Error(`Gemini API (${response.status}) на ${model}: ${errText}`);
              if (attempt < 2) {
                await new Promise(r => setTimeout(r, 1500));
                continue;
              }
              break;
            }
            throw new Error(`Gemini API error (${response.status}): ${errText}`);
          }

          const json = (await response.json()) as any;
          const rawContent = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!rawContent) {
            throw new Error('Нейросеть вернула пустой ответ при редактировании.');
          }

          const cleaned = rawContent
            .trim()
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/```$/i, '')
            .trim();

          const parsed = JSON.parse(cleaned) as any;
          const invoicePayload = parsed.data || parsed;
          const validated = InvoiceDataSchema.parse(invoicePayload);
          validated.items = classifyInvoiceItems(validated.items, validated.warehouse);
          validated.model_used = model;

          const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
            ? parsed.summary.trim()
            : 'Правки накладной успешно применены.';

          console.log(`[Gemini Edit] ✅ Успешно применено моделью ${model}!`);
          return { data: validated, summary };
        } catch (err: any) {
          lastError = err;
          console.warn(`[Gemini Edit] Ошибка ${model}: ${err.message}`);
          if (attempt < 2 && (err.name === 'TimeoutError' || err.message?.includes('503') || err.message?.includes('JSON'))) {
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }
          break;
        }
      }
    }

    throw lastError || new Error('Не удалось применить правки через нейросеть.');
  }

  /**
   * Recognizes handwritten invoice image buffer via Gemini Vision.
   * Features task-tuned model selection and cascade escalation on sum discrepancies.
   */
  async recognize(imageBuffer: Buffer, options: RecognizerOptions = {}, mimeType?: string): Promise<InvoiceData> {
    const photoModels = this.getCandidateModels('photo');
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

    const initialResult = await this.executeGenerateContent(requestBody, false, photoModels);

    // Cascade escalation check
    const shouldCheckEscalation = options.escalateOnDiscrepancy !== false;
    let needsEscalation = false;
    let escalationReason = '';
    const initialCalcSum = initialResult.items.reduce((acc, i) => acc + (i.sum || i.qty * i.price), 0);

    if (shouldCheckEscalation) {
      if (initialResult.items.length === 0) {
        needsEscalation = true;
        escalationReason = 'Первичная модель не обнаружила позиций на изображении накладной.';
      } else {
        // 1. Total written vs calculated sum discrepancy
        if (initialResult.total_written != null && initialResult.total_written > 0) {
          const discrepancy = Math.abs(initialCalcSum - initialResult.total_written);
          if (discrepancy > 30 && (discrepancy / initialResult.total_written) > 0.01) {
            needsEscalation = true;
            escalationReason = `Расхождение с рукописным итогом (на чеке: ${initialResult.total_written} ₽, сумма строк: ${initialCalcSum} ₽, разница: ${discrepancy} ₽).`;
          }
        }

        // 2. Row-level math discrepancy check
        if (!needsEscalation) {
          const badItem = initialResult.items.find(it => {
            const rowCalc = it.qty * it.price;
            return it.sum > 0 && Math.abs(it.sum - rowCalc) > 30 && (rowCalc > 0 ? Math.abs(it.sum - rowCalc) / rowCalc > 0.05 : false);
          });
          if (badItem) {
            needsEscalation = true;
            escalationReason = `Математическое расхождение в строке «${badItem.name}» (кол-во ${badItem.qty} × цена ${badItem.price} = ${badItem.qty * badItem.price} ₽, а распознано ${badItem.sum} ₽).`;
          }
        }
      }
    }

    if (needsEscalation) {
      let escalationCandidates = this.getCandidateModels('complex').filter(m => m !== initialResult.model_used);
      if (escalationCandidates.length === 0) {
        escalationCandidates = this.getCandidateModels('complex');
      }

      if (escalationCandidates.length > 0) {
        console.log(`[Gemini] ⚠️ Запуск каскадной эскалации (${escalationCandidates.join(', ')}): ${escalationReason}`);

        const escalationPrompt = systemPrompt +
          `\n\n⚠️ ВНИМАНИЕ (КАСКАДНАЯ ПРОВЕРКА): ${escalationReason}` +
          `\nТщательно перепроверь рукописный текст на фото:` +
          `\n1) Рукописные «1» и «7» — выбирай цифру, обеспечивающую математическую сходимость строки и чека;` +
          `\n2) Десятичные запятые и точки в количествах и весах (например 1.5 кг vs 15 кг);` +
          `\n3) Слитно написанные числа («15 580» -> 15 * 580);` +
          `\n4) Обязательно найди и извлеки все строки накладной.`;

        const escalationBody = {
          ...requestBody,
          contents: [
            {
              parts: [
                { text: escalationPrompt },
                {
                  inline_data: {
                    mime_type: resolvedMime,
                    data: base64Image
                  }
                }
              ]
            }
          ]
        };

        try {
          const escalatedResult = await this.executeGenerateContent(escalationBody, false, escalationCandidates);
          let isImproved = false;

          if (initialResult.items.length === 0 && escalatedResult.items.length > 0) {
            isImproved = true;
          } else if (escalatedResult.items.length > 0) {
            const escCalcSum = escalatedResult.items.reduce((acc, i) => acc + (i.sum || i.qty * i.price), 0);
            const targetTotal = (escalatedResult.total_written != null && escalatedResult.total_written > 0)
              ? escalatedResult.total_written
              : (initialResult.total_written != null && initialResult.total_written > 0 ? initialResult.total_written : null);

            if (targetTotal != null) {
              const initialDisc = Math.abs(initialCalcSum - targetTotal);
              const escDisc = Math.abs(escCalcSum - targetTotal);
              if (escDisc < initialDisc) {
                isImproved = true;
              }
            } else {
              const initialItemErrors = initialResult.items.filter(it => Math.abs(it.sum - it.qty * it.price) > 30).length;
              const escItemErrors = escalatedResult.items.filter(it => Math.abs(it.sum - it.qty * it.price) > 30).length;
              if (escItemErrors < initialItemErrors) {
                isImproved = true;
              }
            }
          }

          if (isImproved) {
            console.log(`[Gemini] ✅ Эскалация на ${escalatedResult.model_used} улучшила результат распознавания!`);
            escalatedResult.model_used = `${escalatedResult.model_used} (эскалация)`;
            return escalatedResult;
          } else {
            console.log(`[Gemini] Эскалация не дала явного улучшения. Сохраняем результат ${initialResult.model_used}.`);
          }
        } catch (escErr: any) {
          console.warn(`[Gemini] Ошибка при каскадной эскалации: ${escErr.message}. Возврат первичного результата.`);
        }
      }
    }

    return initialResult;
  }

  /**
   * Recognizes voice/audio messages where chefs verbally dictate deliveries.
   */
  async recognizeVoice(audioBuffer: Buffer, mimeType = 'audio/ogg', options: RecognizerOptions = {}): Promise<InvoiceData> {
    const voiceModels = this.getCandidateModels('voice');
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

    return this.executeGenerateContent(requestBody, true, voiceModels);
  }

  /**
   * Applies free-form natural language text edits to current invoice data.
   */
  async recognizeEdit(currentData: InvoiceData, userPrompt: string): Promise<{ data: InvoiceData; summary: string }> {
    const prompt = `Ты профессиональный помощник ресторана «Бейни». Твоя задача — применить пользовательские правки на русском языке к текущей накладной.

Текущие данные накладной:
${JSON.stringify(currentData, null, 2)}

Инструкция / правка от пользователя:
«${userPrompt}»

Правила применения правок:
1. Примени все запрошенные изменения:
   - Изменение цены, количества, единицы товара
   - Удаление указанных строк
   - Добавление новых позиций (рассчитай sum = qty * price)
   - Изменение поставщика, даты или склада
2. Для каждой позиции в "items[].warehouse" обязательно укажи склад:
   - "kitchen" для продуктов питания, мяса, овощей, напитков
   - "household" для хозтоваров (перчатки, салфетки, моющие средства, губки, фольга, контейнеры, уголь, пакеты)
3. В поле "summary" кратко и понятно опиши на русском языке, что было изменено (например: "Изменена цена помидоров на 180 ₽, удалена строка 2").
4. Верни валидный JSON по заданной схеме.`;

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_EDIT_RESPONSE_SCHEMA
      }
    };

    return this.executeEditGenerateContent(requestBody, 'general');
  }

  /**
   * Applies spoken voice edits dictated by chef/manager to current invoice data.
   */
  async recognizeVoiceEdit(currentData: InvoiceData, audioBuffer: Buffer, mimeType = 'audio/ogg'): Promise<{ data: InvoiceData; summary: string }> {
    const base64Audio = audioBuffer.toString('base64');
    const prompt = `Ты профессиональный помощник ресторана «Бейни». Прослушай голосовое аудиосообщение шеф-повара или управляющего с правками и примени их к текущей накладной.

Текущие данные накладной:
${JSON.stringify(currentData, null, 2)}

Правила:
1. Точно извлеки все озвученные правки: изменение цен, количества, добавление товаров, удаление строк, смену поставщика.
2. Для каждой позиции в "items[].warehouse" укажи "kitchen" или "household".
3. Пересчитай sum = qty * price для каждой позиции.
4. В поле "summary" кратко опиши внесенные изменения на русском языке.
5. Верни валидный JSON по заданной схеме.`;

    const requestBody = {
      contents: [
        {
          parts: [
            { text: prompt },
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
        responseSchema: GEMINI_EDIT_RESPONSE_SCHEMA
      }
    };

    return this.executeEditGenerateContent(requestBody, 'voice');
  }
}
