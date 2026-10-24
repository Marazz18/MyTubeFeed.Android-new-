const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const androidDir = path.join(root, 'android');

if (!fs.existsSync(androidDir)) {
  console.log('Složka android/ zatím neexistuje. Spusť nejprve npx cap add android.');
  process.exit(0);
}

// 1. Přepsat MainActivity.java naší verzí s AndroidBridge a podporou Share Intentu
const mainActDest = path.join(androidDir, 'app/src/main/java/cz/mytube/feed/MainActivity.java');
const mainActSrc = path.join(root, 'android-templates/MainActivity.java');
fs.mkdirSync(path.dirname(mainActDest), { recursive: true });
fs.copyFileSync(mainActSrc, mainActDest);
console.log('✓ MainActivity.java aktualizována (AndroidBridge + Share Intent).');

// 2. Upravit AndroidManifest.xml – přidat <queries> pro detekci všech prohlížečů (Android 11+) a SEND intent-filter
const manifestPath = path.join(androidDir, 'app/src/main/AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  let xml = fs.readFileSync(manifestPath, 'utf8');

  if (!xml.includes('android.intent.action.SEND')) {
    const shareFilter = `
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>`;
    xml = xml.replace('</intent-filter>', '</intent-filter>' + shareFilter);
  }

  if (!xml.includes('<queries>')) {
    const queriesBlock = `
    <queries>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="https" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="http" />
        </intent>
    </queries>
</manifest>`;
    xml = xml.replace('</manifest>', queriesBlock);
  }

  fs.writeFileSync(manifestPath, xml, 'utf8');
  console.log('✓ AndroidManifest.xml aktualizován (<queries> pro prohlížeče + Share Intent).');
}
