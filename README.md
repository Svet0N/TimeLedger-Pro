# TimeLedger Pro 🕐

> Проследяване на работни часове и заплата — PWA с Supabase Auth, multi-user, офлайн режим.

---

## 🚀 Бърз старт — GitHub Pages (Demo режим)

1. Качи всички файлове в GitHub репо
2. **Settings → Pages → main / (root)**
3. Отвори сайта → натисни **"Демо режим"**

---

## ⚙️ Supabase интеграция (пълен режим)

### 1. Създай Supabase проект
- [supabase.com](https://supabase.com) → New Project

### 2. Изпълни SQL в Supabase SQL Editor:

```sql
-- Work entries table
CREATE TABLE work_entries (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid REFERENCES auth.users NOT NULL,
  day_key     text NOT NULL,
  hours       numeric(5,2) NOT NULL,
  rate        numeric(6,2) NOT NULL,
  shift_type  text DEFAULT 'normal',
  created_at  timestamptz DEFAULT now(),
  UNIQUE(user_id, day_key)
);

ALTER TABLE work_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_rows" ON work_entries
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- User profiles table
CREATE TABLE user_profiles (
  id           uuid REFERENCES auth.users PRIMARY KEY,
  full_name    text,
  hourly_rate  numeric(6,2) DEFAULT 11,
  accent_color text DEFAULT '#4f8dff',
  monthly_goal int DEFAULT 160,
  role         text DEFAULT 'user',
  rate_history jsonb DEFAULT '[]',
  notif_time   text DEFAULT '20:00',
  created_at   timestamptz DEFAULT now()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_profile" ON user_profiles
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
```

### 3. Обнови `script.js` ред 35-36:

```js
const SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

Намери ги в: Supabase Dashboard → Settings → API

---

## ✨ Функции

| Функция | Описание |
|---------|----------|
| 🔐 **Auth** | Вход/регистрация с Supabase или Demo режим |
| 💰 **Ставка** | Персонална ставка, запазва се в профила. Историческите записи пазят ставката при записването. |
| 📅 **Календар** | Кликни на ден → 6ч / 8ч / 12ч / персонализирано. Swipe за смяна на месец. |
| 🎯 **Месечна цел** | Progress bar + процент изпълнение |
| 🏆 **Бейджове** | 100ч, 160ч, 200ч, 20 дни, 5 дни подред |
| 🔍 **Филтри** | По тип смяна: нормален / 6ч / 12ч / уикенд / извънреден |
| 📊 **4 графики** | По дни, тренд, заплата, разпределение на смени |
| ⬇️ **Експорт** | CSV, PDF (jsPDF), Excel (SheetJS) |
| 🔔 **Известия** | Push напомняния: "Не си добавил часове за вчера" |
| 🎨 **Теми** | 7 акцентни цвята + тъмен/светъл режим |
| 📡 **Офлайн** | Service Worker + localStorage mirror |

---

## 📁 Файлова структура

```
├── index.html          ← HTML структура
├── style.css           ← CSS (glassmorphism, variables, responsive)
├── script.js           ← Цялата логика
├── service-worker.js   ← PWA офлайн поддръжка
├── manifest.json       ← PWA манифест
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

---

## 💡 Мениджър изглед

За да дадеш на потребител роля `manager`, изпълни в Supabase:
```sql
UPDATE user_profiles SET role = 'manager' WHERE id = '<user-uuid>';
```

Мениджърите виждат badge "👔 Мениджър" в профила си.
