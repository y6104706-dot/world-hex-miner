# הגדרת Tunnel לגישה מרחוק לשרת המקומי

כדי שתוכל להתחבר לחשבון שלך גם כשאינך על אותה רשת (למשל בנסיעה), אתה צריך לחשוף את השרת המקומי לאינטרנט.

## אפשרות 1: ngrok (מומלץ)

### התקנה:
```bash
npm install -g ngrok
```

או הורד מ: https://ngrok.com/download

### שימוש:
1. הרץ את השרת המקומי:
   ```bash
   npm start
   ```

2. בחלון טרמינל נוסף, הרץ:
   ```bash
   ngrok http 4000
   ```

3. ngrok יציג URL כמו: `https://abc123.ngrok.io`
4. העתק את ה-URL הזה

5. עדכן את ה-frontend:
   - פתח את `src/App.tsx`
   - מצא את השורה: `const apiBase = (() => {`
   - הוסף לפני השורה הזו:
     ```typescript
     // For tunneling - uncomment and set your ngrok URL:
     // const TUNNEL_URL = 'https://abc123.ngrok.io'
     ```
   - או הגדר משתנה סביבה:
     ```bash
     # Windows PowerShell:
     $env:VITE_API_BASE_URL="https://abc123.ngrok.io"
     npm run dev
     ```

## אפשרות 2: Cloudflare Tunnel (חינמי, ללא הרשמה)

### התקנה:
```bash
npm install -g cloudflared
```

### שימוש:
```bash
cloudflared tunnel --url http://localhost:4000
```

## אפשרות 3: localtunnel (חינמי, ללא הרשמה)

### התקנה:
```bash
npm install -g localtunnel
```

### שימוש:
```bash
lt --port 4000
```

## הערות חשובות:

1. **כל פעם ש-ngrok מתחיל מחדש, ה-URL משתנה** (אלא אם יש לך חשבון בתשלום)
2. **השרת המקומי חייב להיות רץ** בזמן שהטונאל פעיל
3. **הנתונים שלך (users.json) נשארים מקומיים** - זה בטוח
4. **לאבטחה:** השתמש ב-ngrok רק לבדיקות. לייצור, השתמש ב-Render

## עדכון אוטומטי של ה-URL:

אם אתה משתמש ב-ngrok לעיתים קרובות, תוכל להוסיף script שיעדכן את ה-URL אוטומטית.

