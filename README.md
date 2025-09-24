# Upper Deck e-Pack – List View CSV Export (Tampermonkey)

A Tampermonkey userscript to export your **Upper Deck e-Pack** collection from **List view** (grouped `.group` layout) to a CSV.

## Install
1. Install the [Tampermonkey extension](https://www.tampermonkey.net/).
2. Click this link to install the script:  
   [Install Script](https://raw.githubusercontent.com/<your-username>/upperdeck-epack-export/main/upperdeck-epack-list-export.user.js)

## Usage
- Go to [upperdeckepack.com](https://www.upperdeckepack.com/).
- Navigate to **My Collection → List view**.
- Click the floating **“Export ePack CSV”** button.
- The script will scroll through all groups, parse them, and download a CSV of your collection.

## Notes
- Works only in **List view** (`.group` layout).
- If the site changes layout, parsing may need adjustments.

## License
MIT
