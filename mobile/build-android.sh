#!/usr/bin/env bash
# Збирання підписаного APK застосунку ПІС без Android Studio та EAS (Linux-сервер).
#
#   bash build-android.sh <тека з кодом застосунку> <тека для APK>
#
# Інструменти — в ізольованій /opt/android-build (JDK 17, Android SDK 36, NDK 27.1, Node 22), див. README.
# Ключ підпису: /root/.simplexpis/upload.jks, паролі — /root/.simplexpis/signing.env (створюються
# при першому запуску; зробіть їх резервну копію: без ключа не вийде оновити застосунок у магазині).
# Запускати з обмеженням ресурсів, щоб не заважати сервісам на сервері:
#   systemd-run --scope -p MemoryMax=6G -p CPUQuota=400% nice -n 19 ionice -c3 bash build-android.sh ...
set -euo pipefail
APP_DIR=$(realpath "$1")
OUT_DIR=$(realpath -m "$2")
TOOLS=${ANDROID_BUILD_TOOLS:-/opt/android-build}
SIGNING_DIR=${SIMPLEXPIS_SIGNING_DIR:-/root/.simplexpis}
ABIS=${ABIS:-arm64-v8a,armeabi-v7a}

export JAVA_HOME="$TOOLS/jdk" ANDROID_HOME="$TOOLS/sdk" ANDROID_SDK_ROOT="$TOOLS/sdk"
export PATH="$TOOLS/node/bin:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export CI=1 EXPO_NO_TELEMETRY=1 GRADLE_USER_HOME="$TOOLS/gradle-home"

if [ ! -f "$SIGNING_DIR/upload.jks" ]; then
  echo "== Новий ключ підпису $SIGNING_DIR/upload.jks"
  mkdir -p "$SIGNING_DIR" && chmod 700 "$SIGNING_DIR"
  PASS=$(openssl rand -hex 24)
  keytool -genkeypair -v -storetype PKCS12 -keystore "$SIGNING_DIR/upload.jks" -alias simplexpis \
    -keyalg RSA -keysize 4096 -validity 10000 -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=SimplexMed Patient, O=SimplexMed, C=UA" >/dev/null 2>&1
  printf 'SIGNING_STORE_PASSWORD=%s\nSIGNING_KEY_ALIAS=simplexpis\n' "$PASS" > "$SIGNING_DIR/signing.env"
  chmod 600 "$SIGNING_DIR/upload.jks" "$SIGNING_DIR/signing.env"
fi
# shellcheck disable=SC1091
. "$SIGNING_DIR/signing.env"

cd "$APP_DIR"
echo "== node $(node -v), java $(java -version 2>&1 | head -1)"
echo "== npm ci"
# lock-файл створюється на Windows; npm на Linux може вимагати optional-залежностей іншої платформи
# (@emnapi/* для wasm-збірок) — тоді npm install, решту версій так само фіксує package-lock.json
npm ci --no-audit --no-fund --loglevel=error || {
  echo "== npm ci відхилив lock-файл на цій платформі, npm install"
  npm install --no-audit --no-fund --loglevel=error
}
echo "== expo prebuild (android)"
npx expo prebuild --platform android --clean --no-install >/dev/null
echo "== gradle assembleRelease ($ABIS)"
cd android
# android.injected.signing.* — ті самі властивості, що й у «Generate Signed APK» Android Studio
./gradlew assembleRelease --no-daemon --max-workers=4 -PreactNativeArchitectures="$ABIS" \
  -Pandroid.injected.signing.store.file="$SIGNING_DIR/upload.jks" \
  -Pandroid.injected.signing.store.password="$SIGNING_STORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias="$SIGNING_KEY_ALIAS" \
  -Pandroid.injected.signing.key.password="$SIGNING_STORE_PASSWORD"

VERSION=$(node -p "require('$APP_DIR/app.json').expo.version")
mkdir -p "$OUT_DIR"
APK="$OUT_DIR/simplexmed-pis-$VERSION.apk"
cp app/build/outputs/apk/release/app-release.apk "$APK"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs "$APK" | grep -E "Signer #1 certificate (DN|SHA-256)"
sha256sum "$APK"
echo "APK_READY $APK"
