# ANARCHY — نسخة PHP + MySQL للاستضافة التي تختار PHP

النسخة دي بتحافظ على الواجهة الأصلية HTML/CSS/JavaScript، وتستبدل جزءًا من API الخاص بـ Express بـ PHP 8 + MySQL. مش محتاج تختار Node.js في لوحة الاستضافة.

## رفع الموقع

1. اختار preset `php` في لوحة الاستضافة.
2. ارفع **محتويات** مجلد `public_html` إلى مجلد الموقع الرئيسي (غالبًا `public_html` على الاستضافة)، بحيث يكون `index.html` و`router.php` و`.htaccess` في نفس المكان.
3. أنشئ قاعدة بيانات MySQL ومستخدمًا لها من لوحة الاستضافة.
4. ارفع ملف `private/schema.sql` إلى phpMyAdmin ونفّذه داخل قاعدة البيانات الجديدة.
5. انسخ `private/config.sample.php` إلى `private/config.php` وعدّل بيانات MySQL والدومين وDiscord OAuth. مجلد `private` لازم يظل خارج مجلد الموقع العام، جنب `public_html`، وليس بداخله.
6. لو عايز تحتفظ بالبيانات الموجودة في SQLite المرفقة، استورد `private/seed-existing-data.sql` بعد `schema.sql` في قاعدة بيانات فارغة. الملف لا يحتوي على أسرار Discord.
7. في Discord Developer Portal → OAuth2 → Redirects أضف بالضبط `https://YOUR-DOMAIN.example/auth/discord/callback` بعد استبدال الدومين.
8. افتح `https://YOUR-DOMAIN.example/api/health`. المفروض يظهر JSON بحالة `ok` بعد إعداد قاعدة البيانات.

## إعداد Discord Bot المستقل (Python)

1. استخدم مجلد `Discord Bot` على استضافة تدعم تشغيل Python worker بشكل مستمر.
2. ثبّت المتطلبات: `pip install -r requirements.txt`.
3. انسخ `.env.example` إلى `.env` واملأ `DISCORD_TOKEN` و`DISCORD_GUILD_ID` و`ANARCHY_API_URL` و`BOT_API_SECRET`.
4. ضع نفس قيمة `BOT_API_SECRET` في `private/config.php`، وفعّل Server Members Intent من Discord Developer Portal.
5. شغّل `python bot.py`.

## حالة التحويل بصراحة

- المتحوّل حاليًا: Discord OAuth الأساسي، الجلسات، health/auth/me، صلاحيات مبنية على الرتب المتزامنة، الإعدادات، CRUD للمجموعات الأساسية، الصفحات العامة للميديا والأعضاء، سجلات التدقيق، التذاكر، رفع الصور، ومزامنة أعضاء/رتب Discord عبر البوت.
- البوت المنفصل الحالي يعمل كـ bridge لمزامنة الأعضاء/الرتب وقائمة الرتب والقنوات، مع أمر `!anarchy-ping`.
- **لم يتم بعد نقل كل سلوكيات البوت القديمة**: إجراءات تغيير الرتب من لوحة الموقع، إرسال الإعلانات إلى Discord، لوحات الحضور والـ leaderboard، وإشعارات/مراجعة submissions ما زالت تحتاج استكمال الربط والاختبار. بعض endpoints تُرجع `DISCORD_BOT_SERVICE_REQUIRED` بدل الادعاء أنها تعمل.
- لم أستطع اختبار MySQL على استضافة حسابك أو اختبار OAuth حيًّا من هنا. افحص `/api/health` أولًا، ثم تسجيل دخول Discord، ثم الصلاحيات والمهام والرفع قبل اعتماد النسخة.

## ملاحظات أمان

- لا ترفع `private/config.php` إلى `public_html` ولا تضعه داخل GitHub.
- لو ظهر Bot Token أو Client Secret في صور أو Git history، غيّره قبل التشغيل.
- استخدم HTTPS، وقاعدة بيانات مخصصة للمشروع، ونسخًا احتياطية.
- الاستضافة لازم تسمح بـ PHP 8 وPDO MySQL وApache rewrite/.htaccess. لو المنصة لا تدعم `.htaccess`، يلزم ضبط rewrites من إعداداتها.
- رفع ملفات الفيديو إلى PHP hosting قد يتجاوز حدود `upload_max_filesize` أو مساحة التخزين؛ المرفقات الكبيرة تحتاج ضبطًا في لوحة الاستضافة.
