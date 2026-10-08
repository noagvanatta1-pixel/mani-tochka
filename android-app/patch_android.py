"""Донастраивает Android-проект, созданный Capacitor: версия, подпись, иконки, заставка.
Запускается из workflow после `npx cap add android` (рабочая папка: android-app)."""
import os, re, shutil, glob

APP = 'android/app'
gradle_path = f'{APP}/build.gradle'
g = open(gradle_path, encoding='utf-8').read()

code = os.environ.get('VERSION_CODE', '1')
name = os.environ.get('VERSION_NAME', '1.0')
g, n1 = re.subn(r'versionCode\s+\d+', f'versionCode {code}', g, count=1)
g, n2 = re.subn(r'versionName\s+"[^"]*"', f'versionName "{name}"', g, count=1)

signing = '''    signingConfigs {
        release {
            storeFile file(System.getenv("KS_FILE"))
            storePassword System.getenv("KS_PASS")
            keyAlias "kopilka"
            keyPassword System.getenv("KS_PASS")
        }
    }
'''
g, n3 = re.subn(r'(\nandroid\s*\{\s*\n)', lambda m: m.group(1) + signing, g, count=1)
g, n4 = re.subn(r'(buildTypes\s*\{\s*release\s*\{)', r'\1\n            signingConfig signingConfigs.release', g, count=1)
assert n1 and n2 and n3 and n4, f'не удалось поправить build.gradle: {n1} {n2} {n3} {n4}'
open(gradle_path, 'w', encoding='utf-8').write(g)

# иконки
for d in glob.glob('res/mipmap-*'):
    dst = f'{APP}/src/main/res/{os.path.basename(d)}'
    os.makedirs(dst, exist_ok=True)
    for f in glob.glob(f'{d}/*.png'):
        shutil.copy(f, dst)
bg = open('res/ic_launcher_background.txt').read().strip()
vals = f'{APP}/src/main/res/values'
os.makedirs(vals, exist_ok=True)
open(f'{vals}/ic_launcher_background.xml', 'w', encoding='utf-8').write(
    f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">{bg}</color>\n</resources>\n')

# заставка вместо стандартной картинки Capacitor
for f in glob.glob(f'{APP}/src/main/res/drawable*/splash.png'):
    shutil.copy('res/splash.png', f)

# в манифесте: без резервного копирования данных приложения в облако
mp = f'{APP}/src/main/AndroidManifest.xml'
m = open(mp, encoding='utf-8').read()
m = m.replace('android:allowBackup="true"', 'android:allowBackup="false"')
open(mp, 'w', encoding='utf-8').write(m)
print('Проект Android подготовлен: версия', name, code)
