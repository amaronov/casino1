# 1xdep

Казино на игровые фишки: слоты, европейская рулетка и блэкджек. Есть регистрация по имени и паролю, а баланс и история ставок хранятся на сервере. Проект целиком работает на бесплатных тарифах.

- **Страница:** `docs/` на GitHub Pages.
- **Сервер:** Supabase Edge Function `casino` (`supabase/functions/casino`). Она отвечает за вход, сессии и все игры, рандом и выплаты считаются только здесь.
- **База:** PostgreSQL в Supabase (`supabase/migrations`). RLS включён и политик нет, поэтому из браузера к таблицам напрямую не обратиться, работать с ними может только функция.
- **Вход:** пароли хранятся как scrypt-хэши. Сессия — это случайный токен: у игрока он лежит в `localStorage` и уходит на сервер в заголовке `X-Session-Token`, а в базе хранится только его sha256.
- **Защита:**
  - баланс меняется в транзакции с блокировкой строки игрока, поэтому параллельные запросы не могут потратить одни фишки дважды;
  - CORS пропускает только `https://amaronov.github.io` (и localhost для разработки);
  - не больше 20 попыток входа за 10 минут с одного IP.

```
docs/index.html                     интерфейс
docs/config.js                      адрес серверной функции
supabase/migrations/…_init.sql      таблицы
supabase/functions/casino/app.ts    API: вход, игры, ставки
supabase/functions/casino/games.ts  правила игр
supabase/functions/casino/index.ts  точка входа функции
archive/                            самая первая версия для claude.ai
```

## Деплой

### 1. Проект Supabase

1. Зарегистрируйтесь на supabase.com (тариф Free).
2. Нажмите **New project**: имя `casino1`, регион поближе к игрокам (например, Frankfurt), пароль базы сгенерируйте и сохраните.
3. Запомните **Project ID** (он же ref) из **Project Settings → General**. Это строка вида `abcdefghijklmnopqrst`.

### 2. Таблицы

**SQL Editor → New query**: вставьте содержимое `supabase/migrations/20261108000000_init.sql` и нажмите **Run**.

### 3. Серверная функция

```bash
brew install supabase/tap/supabase
```

```bash
supabase login
```

Из папки проекта:

```bash
supabase functions deploy casino --project-ref <PROJECT_ID> --no-verify-jwt --use-api
```

Флаг `--no-verify-jwt` обязателен: страница входит со своим токеном, а не с ключом Supabase.

Если страница будет жить не на `amaronov.github.io`, укажите её адрес:

```bash
supabase secrets set ALLOWED_ORIGINS=https://ваш-адрес --project-ref <PROJECT_ID>
```

### 4. Страница

1. В `docs/config.js` замените `PROJECT_REF` на свой Project ID, затем сделайте коммит и `git push`.
2. На GitHub откройте **Settings → Pages**, выберите **Deploy from a branch**, ветку `main` и папку `/docs`.

Через минуту сайт откроется по адресу `https://amaronov.github.io/casino1/`.

## Локальная разработка

Нужен Docker и Supabase CLI:

```bash
supabase start
```

```bash
supabase functions serve casino --no-verify-jwt
```

В `docs/config.js` укажите `http://127.0.0.1:54321/functions/v1/casino` и откройте `docs/` через любой статический сервер, например `python3 -m http.server -d docs`.

## Ограничения бесплатного тарифа

- Проект Supabase на Free **засыпает после 7 дней без запросов**. Разбудить его можно кнопкой **Restore** в панели Supabase, данные при этом сохраняются.
- Лимиты Free: 500 МБ базы и 500 000 вызовов функции в месяц. Для игры с друзьями этого с запасом хватит.
- Фишки игровые, реальных денег и выплат нет. Восстановления пароля нет.
