# Sistem yeniləməsi (öz server)

Bu versiyadan sonra serveri hər dəfə `net stop / net start MapsPanel` ilə dayandırmaq lazım deyil.

## Bir dəfəlik: 1.1.0-ı quraşdırmaq

Yeniləmə sistemi bu versiya ilə gəlir, ona görə **son dəfə** əl ilə:

```powershell
net stop MapsPanel
# bu zip-in içindəkiləri layihə qovluğunun üzərinə köçürün
# (zip-də data\, .env, node_modules yoxdur, onlara toxunulmur)
cd C:\path\to\Map-Panel-Server\frontend
npm run build
net start MapsPanel
```

Xidmət əvvəlki kimi `node backend\server.js` işlədir. İndi `server.js` kiçik bir nəzarətçidir:
əsl proqramı (`backend\app.js`) ayrıca proses kimi başladır və lazım olanda yalnız onu yenidən başladır.

## Sonrakı yeniləmələr (telefon yeniləməsi kimi)

Server bir dənədir və data hamı üçün eynidir. Fərqli olan yalnız ekrandır (interfeys):

1. Developer kimi daxil olun, yuxarı sağda versiya nişanına basın, `.zip` faylını seçin, **Quraşdır**.
   Server hissəsi bir dəfə quraşdırılır, yeni interfeys ayrıca versiya kimi saxlanılır
   (`frontend\versions\<versiya>\`). Heç kimin ekranı özü dəyişmir.
2. Hər istifadəçidə (admin, baxış, redaktor) yuxarı sağda **zəng** çıxır: yeni versiya və nə yenidir.
3. Hər kəs istədiyi vaxt **Yenilə** basır və yalnız onun ekranı yeni versiyaya keçir.
   Basmayan köhnə ekranla işləməyə davam edir. Hər istifadəçinin seçimi yadda qalır
   (başqa kompüterdən girəndə də öz versiyası açılır).

Son 8 interfeys versiyası saxlanılır. Xəta olsa server faylları avtomatik geri qaytarılır;
tarixçədən son yeniləməni əl ilə də geri almaq olar (o versiyada olanlar qalan ən yeni versiyaya keçir).

Yeniləmə heç vaxt bunlara toxunmur: `data\`, `.env` faylları, `node_modules`, jurnallar, `.git`.
Ehtiyat nüsxələr `.updates\backups\` qovluğundadır.

## Yeniləmə paketi necə hazırlanır

```powershell
node tools\make-update.mjs 1.2.0 "Birinci yenilik" "İkinci yenilik"
```

`updates\map-panel-1.2.0.zip` yaranır. İstənilən zip də olar: içində `backend\`, `frontend\`, `api\` qovluqları
və istəyə görə `update.json` (`{ "version": "1.2.0", "notes": ["…"] }`) olmalıdır.

## Vercel

Vercel-də yeniləmə əvvəlki kimi GitHub push ilə olur; bu pəncərə orada yalnız versiyanı göstərir.
AI Vercel-də cavab verməsə, söhbətdəki xətanın altında **"Səbəbi yoxla"** basın: hansı açarın
(GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY) Vercel-də olmadığını və ya niyə işləmədiyini göstərir.
Açarlar Vercel → Project → Settings → Environment Variables bölməsinə əlavə edilir, sonra Redeploy.
