import asyncio
import logging
import os
import json
import hashlib
from io import BytesIO

import aiohttp
import google.generativeai as genai
from aiogram import Bot, Dispatcher, F
from aiogram.types import Message
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Конфиг ──────────────────────────────────────────────
TELEGRAM_TOKEN   = os.getenv("TELEGRAM_TOKEN")
GEMINI_KEY       = os.getenv("GEMINI_API_KEY")
IIKO_URL         = os.getenv("IIKO_URL", "https://beyni.iikoweb.ru")
IIKO_LOGIN       = os.getenv("IIKO_LOGIN", "dobriev")
IIKO_PASSWORD    = os.getenv("IIKO_PASSWORD")
ALLOWED_USER_IDS = list(map(int, os.getenv("ALLOWED_USER_IDS", "").split(","))) \
                   if os.getenv("ALLOWED_USER_IDS") else []

genai.configure(api_key=GEMINI_KEY)
gemini = genai.GenerativeModel("gemini-1.5-flash")

bot = Bot(token=TELEGRAM_TOKEN)
dp  = Dispatcher(storage=MemoryStorage())

# ── Состояния ────────────────────────────────────────────
class InvoiceState(StatesGroup):
    waiting_confirmation = State()

# ── Gemini: распознавание накладной ──────────────────────
PROMPT = """Ты помощник по распознаванию рукописных накладных ресторана.

Распознай накладную на фото и верни ТОЛЬКО валидный JSON (без пояснений и markdown):

{
  "date": "09.06.2026",
  "supplier": "Бойня",
  "warehouse": "kitchen",
  "items": [
    {"name": "мяшка", "qty": 5.30, "price": 600, "sum": 3200},
    {"name": "карейка", "qty": 7.10, "price": 750, "sum": 5300}
  ],
  "total_written": 14000
}

Правила:
- warehouse: "kitchen" (Склад Кухня) или "household" (Хоз склад)
- Хозтовары (уголь, тряпки, перчатки, моющие средства) → warehouse = "household"
- Перечёркнутые позиции НЕ включай
- Если цена не указана — вычисли как sum/qty
- Если итог не написан — total_written = null
- Верни ТОЛЬКО JSON, ничего больше"""

async def recognize_invoice(image_bytes: bytes) -> dict:
    import PIL.Image
    img = PIL.Image.open(BytesIO(image_bytes))
    response = gemini.generate_content([PROMPT, img])
    text = response.text.strip().replace("```json", "").replace("```", "").strip()
    return json.loads(text)

# ── iiko API ─────────────────────────────────────────────
async def iiko_get_token() -> str:
    pwd_hash = hashlib.sha1(IIKO_PASSWORD.encode()).hexdigest()
    async with aiohttp.ClientSession() as s:
        async with s.get(
            f"{IIKO_URL}/api/1/access_token",
            params={"user_id": IIKO_LOGIN, "user_secret": pwd_hash}
        ) as r:
            data = await r.json(content_type=None)
            return data["token"]

async def iiko_get_org(token: str) -> str:
    async with aiohttp.ClientSession() as s:
        async with s.get(
            f"{IIKO_URL}/api/1/organizations",
            params={"access_token": token}
        ) as r:
            data = await r.json(content_type=None)
            return data["organizations"][0]["id"]

async def iiko_get_stores(token: str, org_id: str) -> list:
    async with aiohttp.ClientSession() as s:
        async with s.get(
            f"{IIKO_URL}/api/1/stores",
            params={"access_token": token, "organization": org_id}
        ) as r:
            data = await r.json(content_type=None)
            return data.get("stores") or data

async def iiko_get_products(token: str, org_id: str) -> list:
    async with aiohttp.ClientSession() as s:
        async with s.get(
            f"{IIKO_URL}/api/1/products",
            params={"access_token": token, "organization": org_id}
        ) as r:
            data = await r.json(content_type=None)
            return data.get("products") or []

async def iiko_create_invoice(token: str, org_id: str, store_id: str,
                               supplier: str, date: str, items: list) -> dict:
    payload = {
        "document": {
            "dateIncoming": date,
            "defaultStore": {"id": store_id},
            "supplier": {"name": supplier},
            "items": items
        }
    }
    async with aiohttp.ClientSession() as s:
        async with s.post(
            f"{IIKO_URL}/api/1/documents/incoming_invoice",
            params={"access_token": token, "organization": org_id},
            json=payload
        ) as r:
            return await r.json(content_type=None)

# ── Форматирование таблицы ────────────────────────────────
def format_table(data: dict) -> str:
    wh = "🏠 Хоз склад" if data.get("warehouse") == "household" else "🍽 Склад Кухня"
    lines = [
        f"📋 *Накладная*",
        f"📅 {data.get('date', '—')}  |  🚛 {data.get('supplier', '—')}",
        f"🏭 {wh}",
        "",
        "`#  Наименование         Кол    Цена   Сумма`",
        "`─────────────────────────────────────────────`",
    ]
    calc = 0
    for i, item in enumerate(data.get("items", []), 1):
        name  = str(item.get("name", ""))[:18].ljust(18)
        qty   = f"{item.get('qty', 0):<6}"
        price = f"{int(item.get('price', 0)):>6}"
        s     = float(item.get("sum", 0) or 0)
        calc += s
        lines.append(f"`{i:<2} {name} {qty} {price} {int(s):>7}`")

    lines.append("`─────────────────────────────────────────────`")
    lines.append(f"`{'ИТОГО':>36} {int(calc):>7}`")

    written = data.get("total_written")
    if written and abs(float(written) - calc) > 1:
        lines.append(f"\n⚠️ На накладной написано *{int(float(written))}* — расхождение {int(abs(float(written)-calc))} руб!")

    lines.append("\n✅ Всё верно? Напиши *ок* — создам накладную в iiko.")
    return "\n".join(lines)

# ── Handlers ─────────────────────────────────────────────
@dp.message(Command("start"))
async def cmd_start(msg: Message):
    if ALLOWED_USER_IDS and msg.from_user.id not in ALLOWED_USER_IDS:
        return
    await msg.answer(
        "👋 Привет, Хамзат!\n\n"
        "📸 Отправь фото накладной — распознаю и подготовлю таблицу.\n"
        "После проверки напиши *ок* — создам накладную в iiko.",
        parse_mode="Markdown"
    )

@dp.message(F.photo)
async def handle_photo(msg: Message, state: FSMContext):
    if ALLOWED_USER_IDS and msg.from_user.id not in ALLOWED_USER_IDS:
        return

    wait = await msg.answer("🔍 Распознаю накладную...")
    try:
        photo = msg.photo[-1]
        file  = await bot.get_file(photo.file_id)
        bio   = BytesIO()
        await bot.download_file(file.file_path, bio)

        data = await recognize_invoice(bio.getvalue())
        await state.update_data(invoice=data)
        await state.set_state(InvoiceState.waiting_confirmation)

        await wait.delete()
        await msg.answer(format_table(data), parse_mode="Markdown")

    except json.JSONDecodeError:
        await wait.edit_text("❌ Не смог разобрать ответ. Попробуй прислать более чёткое фото.")
    except Exception as e:
        logger.exception(e)
        await wait.edit_text(f"❌ Ошибка: {e}")

@dp.message(InvoiceState.waiting_confirmation, F.text.regexp(r"(?i)^о[кk]+[!.]?$"))
async def confirm_ok(msg: Message, state: FSMContext):
    data    = (await state.get_data()).get("invoice", {})
    wait    = await msg.answer("⏳ Создаю накладную в iiko...")
    try:
        token    = await iiko_get_token()
        org_id   = await iiko_get_org(token)
        stores   = await iiko_get_stores(token, org_id)
        products = await iiko_get_products(token, org_id)

        store_id  = find_store(stores, data.get("warehouse", "kitchen"))
        iiko_items = match_items(data.get("items", []), products)
        date       = parse_date(data.get("date", ""))

        result = await iiko_create_invoice(
            token=token, org_id=org_id, store_id=store_id,
            supplier=data.get("supplier", "Закупка"),
            date=date, items=iiko_items
        )
        await state.clear()

        doc = result.get("documentNumber") or result.get("id", "")
        wh  = "Хоз склад" if data.get("warehouse") == "household" else "Склад Кухня"

        if doc:
            await wait.edit_text(
                f"✅ *Накладная создана!*\n\n"
                f"📄 Номер: `{doc}`\n🏭 Склад: {wh}\n\n"
                f"Зайди в iiko и нажми *ПРОВЕСТИ* 👆",
                parse_mode="Markdown"
            )
        else:
            await wait.edit_text(
                f"⚠️ Ответ iiko:\n`{json.dumps(result, ensure_ascii=False)[:500]}`",
                parse_mode="Markdown"
            )
    except Exception as e:
        logger.exception(e)
        await wait.edit_text(f"❌ Ошибка: {e}")

@dp.message(InvoiceState.waiting_confirmation)
async def ask_ok(msg: Message):
    await msg.answer("Напиши *ок* для подтверждения, или пришли новое фото.", parse_mode="Markdown")

# ── Вспомогательные ───────────────────────────────────────
def find_store(stores: list, key: str) -> str:
    kw = {"kitchen": ["кухня", "kitchen"], "household": ["хоз", "household"]}
    for store in stores:
        name = store.get("name", "").lower()
        if any(w in name for w in kw.get(key, [])):
            return store["id"]
    return stores[0]["id"] if stores else ""

def match_items(items: list, products: list) -> list:
    result = []
    for item in items:
        prod = find_product(item.get("name", "").lower(), products)
        entry = {
            "amount": float(item.get("qty", 1)),
            "price":  float(item.get("price", 0)),
            "sum":    float(item.get("sum", 0)),
            "product": {"id": prod["id"]} if prod else {"name": item.get("name", "")}
        }
        result.append(entry)
    return result

def find_product(name: str, products: list) -> dict | None:
    for p in products:
        if p.get("name", "").lower().strip() == name:
            return p
    for p in products:
        if name in p.get("name", "").lower():
            return p
    words = name.split()
    for p in products:
        if all(w in p.get("name", "").lower() for w in words):
            return p
    return None

def parse_date(d: str) -> str:
    try:
        parts = d.replace("/", ".").split(".")
        if len(parts) == 3:
            day, mon, yr = parts
            return f"{yr}-{mon.zfill(2)}-{day.zfill(2)}T00:00:00"
    except Exception:
        pass
    from datetime import date
    return date.today().strftime("%Y-%m-%dT00:00:00")

# ── Запуск ────────────────────────────────────────────────
async def main():
    logger.info("🤖 Beyni Bot запущен")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
