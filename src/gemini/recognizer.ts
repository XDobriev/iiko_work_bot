import { config } from '../config.js';
import { InvoiceData, InvoiceDataSchema } from '../types/index.js';

export interface RecognizerOptions {
  knownItems?: string[];
  knownSuppliers?: string[];
}

export class GeminiInvoiceRecognizer {
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || config.gemini.apiKey;
    this.model = model || config.gemini.model;
  }

  /**
   * Recognizes handwritten invoice image buffer via Gemini 3.8 Flash Vision.
   * Feeds historical context (known suppliers & items) to continuously improve accuracy.
   */
  async recognize(imageBuffer: Buffer, options: RecognizerOptions = {}): Promise<InvoiceData> {
    const base64Image = imageBuffer.toString('base64');

    let memoryContext = '';
    if (options.knownSuppliers && options.knownSuppliers.length > 0) {
      memoryContext += `\nИзвестные поставщики ресторана: ${options.knownSuppliers.slice(0, 30).join(', ')}.`;
    }
    if (options.knownItems && options.knownItems.length > 0) {
      memoryContext += `\nИзвестные позиции/товары из предыдущих накладных: ${options.knownItems.slice(0, 80).join(', ')}.`;
    }

    const systemPrompt = `Ты профессиональный помощник ресторана по распознаванию рукописных накладных и товарных чеков на русском языке.
Твоя задача — точно извлечь все позиции, цены, количества, суммы, дату, поставщика и склад.
${memoryContext ? memoryContext + '\nИспользуй эти известные названия для уточнения неразборчивого почерка, если они совпадают.' : ''}

Правила:
1. "date": дата накладной в формате "ДД.ММ.ГГГГ" (если год не указан, поставь текущий год 2026).
2. "supplier": название поставщика (например: "Бойня", "Овощи", "ИП Иванов", "Закупка").
3. "warehouse": "kitchen" (Склад Кухня — продукты питания, мясо, овощи, бакалея) или "household" (Хоз склад — моющие средства, перчатки, салфетки, уголь, тряпки, упаковка).
4. "items": массив позиций.
   - "name": понятное наименование товара (на русском языке, без опечаток).
   - "qty": количество (число с плавающей точкой, например 5.3 или 10).
   - "price": цена за единицу (рублей). Если цена не указана, но есть сумма и кол-во — рассчитай как sum / qty.
   - "sum": итоговая сумма по позиции. Если не указана — qty * price.
5. Перечеркнутые или отмененные позиции НЕ включай!
6. "total_written": числовая итоговая сумма, которая написана внизу накладной от руки (или null, если итог не написан явно).
7. Верни ТОЛЬКО валидный JSON в соответствии со схемой, без markdown и без лишнего текста.`;

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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const json = (await response.json()) as any;
    const candidate = json.candidates?.[0];
    const rawContent = candidate?.content?.parts?.[0]?.text;

    if (!rawContent) {
      throw new Error('Gemini вернул пустой ответ или заблокировал содержимое.');
    }

    // Clean any markdown formatting if present
    const cleaned = rawContent
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    // Validate with Zod
    return InvoiceDataSchema.parse(parsed);
  }
}
