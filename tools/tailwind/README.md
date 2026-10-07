# Стилі веб-кабінету «Плексі»

`web/app.css` збирається з класів у `web/index.html`. Після зміни розмітки перезберіть:

    npx -y tailwindcss@3.4.17 -c pis/tools/tailwind/tailwind.config.cjs -i pis/tools/tailwind/input.css -o pis/web/app.css --minify

(з кореня репозиторію). Кольори — токени з `:root` у `web/index.html`, тому світла і нічна теми не потребують окремих класів.
