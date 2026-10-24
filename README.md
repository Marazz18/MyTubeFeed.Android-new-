# MyTube Feed (Browser Extension + Android APK s Nostr Sync)

Soukromý YouTube RSS/Atom čtečka a správce kanálů bez nutnosti Google účtu. Funguje jako **rozšíření do prohlížeče na PC** i jako **nativní Android aplikace (APK)** propojená přes šifrovanou **Nostr synchronizaci (NIP-44 + NIP-78)**.

## Hlavní funkce
- **Vlastní složky a tagy kanálů** – organizace kanálů nezávisle na YouTube algoritmu.
- **Watch later & Sledování zhlédnutých videí** – přehled nových videí a filtrování zhlédnutých či Shorts.
- **Šifrovaná synchronizace přes Nostr (NIP-44)** – 3-way merge mezi PC a Androidem přes Nostr relaye (`mytube:core`, `mytube:wl`, `mytube:watched`).
- **Otevírání videí ve zvoleném prohlížeči na Androidu** – přímé spuštění videa v **Brave**, **Firefoxu**, **Fennec**, **Cromite**, **NewPipe**, **PipePipe**, **Grayjay** nebo systémovém výběru prohlížečů (obchází nucené otevírání oficiální YouTube aplikace).
- **Sdílení z jiných aplikací (Android Share Intent)** – v Brave, Firefoxu nebo YouTube stačí dát *Sdílet -> MyTube Feed* pro okamžité uložení videa do Watch later nebo přidání kanálu do složky.

---

## 1. Použití jako rozšíření na PC (Chrome / Brave / Vivaldi)
1. Otevři `chrome://extensions` a zapni **Režim pro vývojáře**.
2. Klikni na **Načíst rozbalené** a vyber kořenovou složku tohoto repozitáře.

---

## 2. Sestavení Android APK

### Varianta A: Automaticky přes GitHub Actions (bez instalace Android Studia)
Repozitář obsahuje workflow `.github/workflows/build-apk.yml`:
1. Nahraj repozitář na GitHub.
2. V záložce **Actions -> Build Android APK & Release** klikni na **Run workflow**, nebo vytvoř tag (např. `git tag v0.9.4 && git push origin v0.9.4`).
3. Hotové `MyTube-Feed.apk` se automaticky připojí do **GitHub Releases**.

### Varianta B: Lokálně na počítači
```bash
npm install
npm run cap:init
cd android && ./gradlew assembleDebug
```
Výsledné APK najdeš v `android/app/build/outputs/apk/debug/app-debug.apk`.

---

## 3. Publikace na Zapstore (Nostr App Store)
Projekt obsahuje připravený konfigurační soubor `zapstore.yaml`.
1. Nainstaluj Zapstore CLI (`zsp`) ze stránky [github.com/zapstore/zsp/releases](https://github.com/zapstore/zsp/releases) nebo přes Go:
   ```bash
   go install github.com/zapstore/zsp@latest
   ```
2. V `zapstore.yaml` doplň svůj `pubkey: npub1...` a commitni ho na GitHub.
3. Publikuj aplikaci příkazem:
   ```bash
   zsp publish --wizard
   ```
