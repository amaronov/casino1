# Зелёное сукно

Казино на игровые фишки: слоты, европейская рулетка и блэкджек. Есть регистрация по имени и паролю, а баланс и история ставок хранятся на сервере.

- **Сервер:** Node.js 24 без npm-зависимостей (`node:http`, `node:sqlite`, `node:crypto`).
- **База:** один файл SQLite в `DATA_DIR` (по умолчанию `./data/casino.db`).
- **Игры:** все случайные числа и выплаты считает сервер, браузер только показывает результат.
- **Вход:** пароли хранятся как scrypt-хэши, сессия держится в cookie `HttpOnly; SameSite=Lax` 30 дней.
- **Защита:**
  - запросы с чужих сайтов (CSRF) отклоняются по заголовку `Origin`, а API принимает только JSON;
  - не больше 20 попыток входа или регистрации за 10 минут с одного IP;
  - заголовки CSP и `X-Frame-Options`.

```
server.js        HTTP, авторизация, API
src/games.js     правила и рандом всех игр
public/index.html  интерфейс
Dockerfile       образ для Coolify
```

## Локальный запуск

Нужен Node.js 22.13 или новее. На Node 22.x до 22.13 SQLite включается флагом, он уже прописан в `npm run dev`.

```bash
npm run dev
```

Откройте http://localhost:3000.

## Переменные окружения

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `PORT` | `3000` | Порт HTTP-сервера |
| `DATA_DIR` | `./data` (в Docker — `/app/data`) | Папка с файлом базы |
| `NODE_ENV` | `production` в Docker | В production cookie ставится с флагом `Secure` |
| `COOKIE_SECURE` | `true` в production | Поставьте `false`, только если сайт открывается по **http** без сертификата |
| `TRUST_PROXY` | `true` | Брать IP игрока из `X-Forwarded-For` (Coolify стоит за прокси Traefik) |

## Деплой в Coolify

### 0. Сервер с Coolify

Coolify разворачивает приложения на **вашем** сервере (VPS от 2 ГБ RAM, Ubuntu/Debian). Есть два варианта:

- **Coolify Cloud** (на coolify.io). Панель управления держат они, а вы подключаете свой VPS по SSH: Servers → Add Server.
- **Свой Coolify** на этом же VPS:
  ```bash
  curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
  ```
  После установки панель доступна по адресу `http://<IP-сервера>:8000`.

### 1. Код на GitHub

```bash
git init -b main
git add .
git commit -m "Зелёное сукно: первая версия"
```

Создайте пустой репозиторий на GitHub, затем:

```bash
git remote add origin git@github.com:<вы>/zelenoe-sukno.git
git push -u origin main
```

### 2. Ресурс в Coolify

1. **Projects → + Add**: создайте проект, например `casino`, и откройте окружение `production`.
2. **+ New → Resource** и выберите источник:
   - **Public Repository**, если репозиторий открытый: вставьте его URL;
   - **Private Repository (with GitHub App)**, если закрытый: Coolify предложит установить GitHub App с доступом к этому репозиторию.
3. Выберите сервер, ветку `main`, а в поле **Build Pack** укажите **Dockerfile**.

### 3. Настройки приложения (вкладка General)

- **Ports Exposes:** `3000`.
- **Domains:** `https://casino.ваш-домен.ru`. Префикс `https://` важен: с ним Coolify сам выпустит сертификат Let's Encrypt.
  - У регистратора домена добавьте **A-запись** `casino` → IP вашего сервера.
  - Если домена нет, нажмите **Generate Domain**: получится адрес вида `http://….sslip.io`. Он открывается по http, поэтому добавьте переменную `COOKIE_SECURE=false`, иначе браузер не сохранит cookie и вход не заработает.

### 4. Постоянное хранилище (обязательно)

Без этого шага база удаляется при каждом деплое.

**Persistent Storage → + Add → Volume**:
- Name: `casino-data`
- Destination Path: `/app/data`

### 5. Проверка здоровья (по желанию)

**Health Checks:** включите проверку с путём `/healthz` и портом `3000`. В Dockerfile такая проверка тоже есть.

### 6. Деплой

Нажмите **Deploy** и дождитесь в логах сборки строки `Зелёное сукно: http://localhost:3000`. Откройте свой домен, зарегистрируйтесь и сыграйте раунд.

Чтобы каждый `git push` в `main` выкатывался сам, включите **Auto Deploy** в настройках ресурса (с GitHub App он включён по умолчанию).

## Резервные копии

Файлы базы лежат в томе `casino-data`. Чтобы сделать копию, найдите на сервере контейнер и скопируйте из него папку с базой (останавливать его не нужно):

```bash
docker ps --filter "volume=casino-data"
```

```bash
docker cp <container>:/app/data ./casino-backup-$(date +%F)
```

Копируйте всю папку целиком: при работающей базе рядом с `casino.db` лежат файлы `-wal` и `-shm`, и они тоже нужны.

## Ограничения

- Фишки игровые, реальных денег и выплат нет.
- Сервер рассчитан на один экземпляр приложения: SQLite — это файл на одном томе. Не включайте несколько реплик.
- Восстановления пароля нет, потому что почта при регистрации не спрашивается.
