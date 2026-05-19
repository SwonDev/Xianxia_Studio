"""Helper that boots the bundled sidecar on an alt port for testing
without conflicting with the user's installed app on 8731.
"""
import os, sys
os.environ["XIANXIA_TEST_PORT"] = os.environ.get("XIANXIA_TEST_PORT", "8741")
SIDECAR = r"C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\runtime\sidecar-py\server.py"
sys.path.insert(0, r"C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\runtime\sidecar-py\src")
ns = {"__name__": "__main__", "__file__": SIDECAR}
src = open(SIDECAR, encoding="utf-8").read()
src = src.replace("port=8731", "port=int(os.environ.get('XIANXIA_TEST_PORT','8731'))")
exec(compile(src, SIDECAR, "exec"), ns)
