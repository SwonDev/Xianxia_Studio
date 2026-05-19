import sys
sys.path.insert(0, r'C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\runtime\depthflow-venv\Lib\site-packages')
from depthflow.scene import DepthScene
scene = DepthScene(backend='headless')
scene.input(image=r'C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\runtime\comfyui\output\xianxia_00151_.png')
scene.main(time=5, fps=24, output=r'C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\out\depthflow-test.mp4', height=1080, width=1920)
print('OK', r'C:\Users\swon_\AppData\Roaming\xianxia\XianxiaStudio\data\out\depthflow-test.mp4')
