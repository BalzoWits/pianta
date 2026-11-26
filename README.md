# Pianta

Progetta casa nel browser: pianta 2D con quote, ricalco da foto, vista 3D e render fotorealistico.

- **Pianta 2D**: pareti con agganci (angoli, allineamenti, griglia), lunghezze scritte da tastiera, stanze riconosciute da sole con superficie, porte e finestre, quote automatiche e libere; doppio clic su una misura per cambiarla.
- **Da foto**: carichi la foto della planimetria, la raddrizzi, la scala si ricava leggendo le quote scritte (OCR nel browser) o con una misura nota; poi ricalchi i muri, che si agganciano al centro dei muri disegnati e ne prendono lo spessore.
- **3D**: orbita o passeggiata all'altezza degli occhi, arredi parametrici ridimensionabili o modelli 3D importati (OBJ, STL, GLB/GLTF) semplificati in automatico.
- **Render**: path tracing su WebGPU con pulizia del rumore finale (ripiego su WebGL dove WebGPU non c'è).
- Progetti salvati nel browser e, con l'accesso Google, online su tutti i dispositivi.

Librerie: [three.js](https://threejs.org), [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh), [Tesseract.js](https://tesseract.projectnaptha.com), [oidn-webgpu](https://github.com/pissang/oidn-webgpu) con i pesi di [Open Image Denoise](https://github.com/RenderKit/oidn-weights) (Apache 2.0). Licenze in `lib/licenses` e `lib/oidn`.
