@echo off
chcp 65001 > nul
title Telegram Mini App Tunnel - Бейни
echo ========================================================
echo   HTTPS-туннель для Telegram Mini App ресторана Бейни
echo ========================================================
echo.
echo Локальный веб-сервер бота работает на порту 3000.
echo Сейчас будет создан публичный защищенный HTTPS-адрес,
echo чтобы Mini App открывался на смартфонах внутри Telegram.
echo.
cd /d "%~dp0"
if exist "cloudflared.exe" (
  echo Запуск через Cloudflare Tunnel (порт 3000)...
  echo Скопируйте ссылку trycloudflare.com и укажите в .env: WEBAPP_URL=https://...
  echo.
  .\cloudflared.exe tunnel --url http://localhost:3000
) else (
  echo Запуск через Localtunnel (порт 3000)...
  call npx localtunnel --port 3000
)
pause
