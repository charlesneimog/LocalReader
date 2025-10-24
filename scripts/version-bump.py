import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
FILE_PATH = (SCRIPT_DIR / "../src/config.js").resolve()

# Tipo de bump: build (padrão), patch, minor ou major
bump_type = sys.argv[1] if len(sys.argv) > 1 else "build"

content = FILE_PATH.read_text(encoding="utf-8")

# Extrair versões atuais
major = int(re.search(r"VERSION_MAJOR:\s*(\d+)", content).group(1))
minor = int(re.search(r"VERSION_MINOR:\s*(\d+)", content).group(1))
patch = int(re.search(r"VERSION_PATCH:\s*(\d+)", content).group(1))
build = int(re.search(r"VERSION_BUILD:\s*(\d+)", content).group(1))

# Incrementar conforme tipo
if bump_type == "major":
    major += 1
    minor = patch = build = 0
elif bump_type == "minor":
    minor += 1
    patch = build = 0
elif bump_type == "patch":
    patch += 1
    build = 0
else:  # build (default)
    build += 1

# Substituir no arquivo
content = re.sub(r"(VERSION_MAJOR:\s*)\d+", rf"\g<1>{major}", content)
content = re.sub(r"(VERSION_MINOR:\s*)\d+", rf"\g<1>{minor}", content)
content = re.sub(r"(VERSION_PATCH:\s*)\d+", rf"\g<1>{patch}", content)
content = re.sub(r"(VERSION_BUILD:\s*)\d+", rf"\g<1>{build}", content)

FILE_PATH.write_text(content, encoding="utf-8")

# SW
SW_PATH = (SCRIPT_DIR / "../sw.js").resolve()
version_str = f"{major}.{minor}.{patch}+{build}"
sw_content = SW_PATH.read_text(encoding="utf-8")
if re.search(r'const APP_VERSION\s*=\s*["\'].*["\'];', sw_content):
    sw_content = re.sub(
        r'const APP_VERSION\s*=\s*["\'].*["\'];',
        f'const APP_VERSION = "{version_str}";',
        sw_content,
    )
else:
    sw_content = f'const APP_VERSION = "{version_str}";\n' + sw_content
SW_PATH.write_text(sw_content, encoding="utf-8")


print(f"✅ Versão atualizada para {major}.{minor}.{patch}+{build}")
