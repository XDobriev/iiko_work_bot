import asyncio
import logging
import os
import json
import hashlib
from io import BytesIO

import aiohttp
from aiogram import Bot, Dispatcher, F
from aiogram.types import Message
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.client.session.aiohttp import AiohttpSession
from dotenv import load_dotenv

try:
    from google import genai
    from google.genai import types as genai_types
    USE_NEW_SDK = True
except ImportError:
    import google.generativeai as genai_old
    USE_NEW_SDK = False

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TELEGRAM_TOKEN   = os.getenv("TELEGRAM_TOKEN")
GEMINI_KEY       = os.getenv("GEMINI_API_KEY")
IIKO_URL         = os.getenv("IIKO_URL", "https://beyni.iikoweb.ru")
IIKO_LOGIN       = os.getenv("IIKO_LOGIN", "dobriev")
IIKO_PASSWORD    = os.getenv("IIKO_PASSWORD")
PROXY_URL        = os.getenv("PROXY_URL", "")  # напр. socks5://user:pass@host:port

# ── Gemini ────────────────────────────────────────────────
if USE_NEW_SDK:
    gemini_client = genai.Client(api_key=GEMINI_KEY)
else:
    genai_old.configure(api_key=GEMINI_KEY)
    gemini_model = genai_old.GenerativeModel("gemini-1.5-flash")

# ── Telegram Bot с поддержкой прокси ─────────────────────
if PROXY_URL:
    session = AiohttpSession(proxy=PROXY_URL)
    bot = Bot(token=TELEGRAM_TOKEN, session=session)
    logger.info(f"Используем прокси: {PROXY_URL}")
else:
    bot = Bot(token=TELEGRAM_TOKEN)

dp = Dispatcher(storage=MemoryStorage())

# ── Состояния ─────────────────────────────────────────────
class InvoiceState(StatesGroup):
    waiting_confirmation = State()

PROMPT = """Ты помощник по распознаванию рукописных накладных ресторана.

Распознай накладную на фото и верни ТОЛЬКО валидный JSON (без пояснений и markdown):

{
  "date": "09.06.2026",
  "supplier": "Бойня",
  "warehouse": "kitchen",
  "items": [
    {"name": "мяшка", "qty": 5.30, "price": 600, "sum": 3200}
  ],
  "total_written": 14000
}

Правила:
- warehouse: "kitchen" (Склад Кухня) или "household" (Хоз склад)
- Хозтовары (уголь, тряпки, перчатки, моющие средства) -> warehouse = "household"
- Перечёркнутые позиции НЕ включай
- Если цена не указана — вычисли как sum/qty
- Если итог не написан — total_written = null
- Верни ТОЛЬКО JSON, ничего больше"""

async def recognize_invoice(image_bytes: bytes) -> dict:
    import PIL.Image
    img = PIL.Image.open(BytesIO(image_bytes))

    if USE_NEW_SDK:
        response = gemini_client.models.generate_content(
            model="gemini-1.5-flash",
            contents=[PROMPT, img]
        )
        text = response.text.strip()
    else:
        response = gemini_model.generate_content([PROMPT, img])
        text = response.text.strip()

    text = text.replace("```json", "").replace("```", "").strip()
    return json.loads(text)

# ── iiko API ──────────────────────────────────────────────
async def iiko_get_token() -> str:
    pwd_hash = hashlib.sha1(IIKO_PASSWORD.encode()).hexdigest()
    async with aiohttp.ClientSession() as s:
        async with s.get(
            f"{IIKO_URL}/api/1/access_token",
            params={"user_id": IIKO_LOGIN, "user_secret": pwd_hash}
        ) as r:
            return (await r.json(content_type=None))["token"]

async def iiko_get_org(token: str) -> str:
    async with aiohttp.ClientSession() as s:
        async with s.get(
            f"{IIKO_URL}/api/1/organizations",
            params={"access_token": token}
        ) as r:
            return (await r.json(content_type=None))["organizations"][0]["id"]

async def iiko_get_stores(token: str, org_id: str) -> list:
    async with aiohttp.ClientSession() as s:
        async with s.get(
            f"{IIKO_URL}/api/1/stores",
            params={"access_token": token, "organization": org_id}
        ) as r:
            d = await r.json(content_type=None)
            return d.get("stores") or d

async def iiko_get_products(token: str, org_id: str) -> list:
    async with aiohttp.ClientSession() as s:
        async with s.get(
            f"{IIKO_URL}/api/1/products",
            params={"access_token": token, "organization": org_id}
        ) as r:
            d = await r.json(content_type=None)
            return d.get("products") or []

async def iiko_create_invoice(token, org_id, store_id, supplier, date, items):
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
        f"📅 {data.get('date','—')}  |  🚛 {data.get('supplier','—')}",
        f"🏭 {wh}", "",
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
    w = data.get("total_written")
    if w and abs(float(w) - calc) > 1:
        lines.append(f"\n⚠️ На накладной написано *{int(float(w))}* — расхождение!")
    lines.append("\n✅ Всё верно? Напиши *ок* — создам накладную в iiko.")
    return "\n".join(lines)

# ── Handlers ──────────────────────────────────────────────
@dp.message(Command("start"))
async def cmd_start(msg: Message):
    await msg.answer(
        "👋 Привет, Хамзат!\n\n"
        "📸 Отправь фото накладной — распознаю и подготовлю таблицу.\n"
        "После проверки напиши *ок* — создам накладную в iiko.",
        parse_mode="Markdown"
    )

@dp.message(F.photo)
async def handle_photo(msg: Message, state: FSMContext):
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
        await wait.edit_text("❌ Не смог разобрать. Пришли более чёткое фото.")
    except Exception as e:
        logger.exception(e)
        await wait.edit_text(f"❌ Ошибка: {e}")

@dp.message(InvoiceState.waiting_confirmation, F.text.regexp(r"(?i)^о[кk]+[!.]?$"))
async def confirm_ok(msg: Message, state: FSMContext):
    data = (await state.get_data()).get("invoice", {})
    wait = await msg.answer("⏳ Создаю накладную в iiko...")
    try:
        token    = await iiko_get_token()
        org_id   = await iiko_get_org(token)
        stores   = await iiko_get_stores(token, org_id)
        products = await iiko_get_products(token, org_id)

        kw = {"kitchen": ["кухня", "kitchen"], "household": ["хоз", "household"]}
        wkey = data.get("warehouse", "kitchen")
        store_id = next(
            (s["id"] for s in stores if any(w in s.get("name","").lower() for w in kw.get(wkey,[]))),
            stores[0]["id"] if stores else ""
        )

        def fp(name):
            n = name.lower()
            for p in products:
                if p.get("name","").lower().strip() == n: return p
            for p in products:
                if n in p.get("name","").lower(): return p
            return None

        items = [{
            "amount": float(i.get("qty", 1)),
            "price":  float(i.get("price", 0)),
            "sum":    float(i.get("sum", 0)),
            "product": {"id": fp(i.get("name",""))["id"]} if fp(i.get("name","")) else {"name": i.get("name","")}
        } for i in data.get("items", [])]

        try:
            parts = data.get("date","").split(".")
            date = f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}T00:00:00"
        except Exception:
            from datetime import date as d
            date = d.today().strftime("%Y-%m-%dT00:00:00")

        result = await iiko_create_invoice(token, org_id, store_id,
                                           data.get("supplier","Закупка"), date, items)
        await state.clear()
        doc = result.get("documentNumber") or result.get("id","")
        wh  = "Хоз склад" if wkey == "household" else "Склад Кухня"
        if doc:
            await wait.edit_text(
                f"✅ *Накладная создана!*\n\n📄 Номер: `{doc}`\n🏭 {wh}\n\nЗайди в iiko и нажми *ПРОВЕСТИ* 👆",
                parse_mode="Markdown"
            )
        else:
            await wait.edit_text(
                f"⚠️ Ответ iiko:\n`{json.dumps(result, ensure_ascii=False)[:400]}`",
                parse_mode="Markdown"
            )
    except Exception as e:
        logger.exception(e)
        await wait.edit_text(f"❌ Ошибка: {e}")

@dp.message(InvoiceState.waiting_confirmation)
async def ask_ok(msg: Message):
    await msg.answer("Напиши *ок* для подтверждения или пришли новое фото.", parse_mode="Markdown")

# ── Запуск ────────────────────────────────────────────────
async def main():
    logger.info("🤖 Beyni Bot запущен")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
