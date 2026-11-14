@echo off
chcp 65001 > nul
title iiko Work Bot - Ресторан Бейни
echo ===================================================
echo  Запуск Telegram-бота @iiko_work_bot
echo ===================================================
echo.
cd /d "%~dp0"
call npm run dev
pause
