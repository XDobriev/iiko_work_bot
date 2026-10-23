import { config } from '../config.js';
import { InvoiceData, InvoiceDataSchema } from '../types/index.js';

export interface RecognizerOptions {
  knownItems?: string[];
  knownItemsWithUnits?: Array<{ name: string; unit?: string }>;
  knownSuppliers?: string[];
}

export class GeminiInvoiceRecognizer {
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || config.gemini.apiKey;
    this.model = model || config.gemini.model;
  }

  private buildSystemPrompt(options: RecognizerOptions, isVoice = false): string {
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
1. "date": дата накладной в формате "ДД.ММ.ГГГГ" (если год не указан, поставь текущий год 2026).
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
7. Верни ТОЛЬКО валидный JSON в соответствии со схемой, без markdown и без лишнего текста.`;
  }

  private getCandidateModels(): string[] {
    const list = [
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      this.model,
      'gemini-3-flash-preview'
    ].filter(Boolean);
    // Exclude gemini-3.8-flash during global 503 outage
    return Array.from(new Set(list)).filter(m => m !== 'gemini-3.8-flash');
  }

  private async executeGenerateContent(requestBody: any, isVoice = false): Promise<InvoiceData> {
    const candidateModels = this.getCandidateModels();
    let lastError: any = null;

    for (const model of candidateModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[Gemini] Запрос к ${model} (попытка ${attempt}/2)...`);
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
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

          const parsed = JSON.parse(cleaned);
          const validated = InvoiceDataSchema.parse(parsed);
          console.log(`[Gemini] ✅ Успешно распознано моделью ${model}!`);
          return validated;
        } catch (err: any) {
          lastError = err;
          console.warn(`[Gemini] Ошибка вызова ${model} (попытка ${attempt}): ${err.message}`);
          if (attempt < 2 && (err.name === 'TimeoutError' || err.message?.includes('503'))) {
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
   * Recognizes handwritten invoice image buffer via Gemini 3.8 Flash Vision.
   */
  async recognize(imageBuffer: Buffer, options: RecognizerOptions = {}): Promise<InvoiceData> {
    const base64Image = imageBuffer.toString('base64');
    const systemPrompt = this.buildSystemPrompt(options, false);

    const requestBody = {
      contents: [
        {
          parts: [
            { text: systemPrompt },
            {
              inline_data: {
                mime_type: 'image/jpeg',
                data: base64Image
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
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
        responseMimeType: 'application/json'
      }
    };

    return this.executeGenerateContent(requestBody, true);
  }
}
