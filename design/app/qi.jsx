// Qi particles — drifting golden motes
const QiParticles = () => {
  const ref = React.useRef(null);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let raf;
    let dpr = window.devicePixelRatio || 1;
    let w, h;

    const resize = () => {
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
    };
    resize();

    const N = 26;
    const particles = Array.from({ length: N }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.6 + Math.random() * 1.8,
      v: 0.08 + Math.random() * 0.25,
      a: 0.12 + Math.random() * 0.22,
      sw: 0.5 + Math.random() * 1.2,
      ph: Math.random() * Math.PI * 2,
    }));

    const tick = (t) => {
      ctx.clearRect(0, 0, w, h);
      particles.forEach((p) => {
        p.y -= p.v;
        p.x += Math.sin((t / 1800 + p.ph)) * 0.15;
        if (p.y < -10) {
          p.y = h + 10;
          p.x = Math.random() * w;
        }
        const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
        grd.addColorStop(0, `rgba(232, 201, 109, ${p.a})`);
        grd.addColorStop(1, "rgba(232, 201, 109, 0)");
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(245, 222, 145, ${p.a + 0.15})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onResize = () => resize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas ref={ref} className="qi-canvas" />;
};

window.QiParticles = QiParticles;
