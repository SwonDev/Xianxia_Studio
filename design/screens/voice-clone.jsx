/* eslint-disable */
// Voice clone wizard — mic capture, waveform, test, save.

function VoiceCloneWizard({ open, onClose }) {
  const [step, setStep] = React.useState("intro"); // intro → record → review → name → done
  const [recording, setRecording] = React.useState(false);
  const [recTime, setRecTime] = React.useState(0);
  const [hasSample, setHasSample] = React.useState(false);
  const [name, setName] = React.useState("Mi voz");
  const [testText, setTestText] = React.useState("Bajo los Nueve Cielos, donde la luz se quiebra contra picos de jade.");

  React.useEffect(() => {
    if (!recording) return;
    setRecTime(0);
    const id = setInterval(() => {
      setRecTime(t => {
        if (t + 0.1 >= 5) {
          setRecording(false);
          setHasSample(true);
          setStep("review");
          return 5;
        }
        return t + 0.1;
      });
    }, 100);
    return () => clearInterval(id);
  }, [recording]);

  if (!open) return null;

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 120,
      background: "rgba(6,18,14,0.65)",
      backdropFilter: "blur(16px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 560,
        background: "rgba(40,40,46,0.55)",
        backdropFilter: "blur(60px) saturate(190%)",
        WebkitBackdropFilter: "blur(60px) saturate(190%)",
        borderRadius: 18,
        boxShadow: "var(--shadow-popover)",
        overflow: "hidden",
        animation: "fade-up 280ms var(--ease-spring) both",
      }}>
        {/* Header */}
        <div style={{
          padding: "16px 22px",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <span className="lg-tile lg" style={{ "--tint": "#d4b85a" }}>
            <I.Mic size={15}/>
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Clonar voz</div>
            <div className="caption">Qwen3-TTS · 5 segundos bastan</div>
          </div>
          <button className="btn-ghost" onClick={onClose}><I.X size={11}/></button>
        </div>

        <div className="hr"/>

        <div style={{ padding: 24, minHeight: 320 }}>
          {step === "intro" && (
            <div className="fade-up">
              <p className="muted" style={{ margin: "0 0 16px", lineHeight: 1.5 }}>
                Para clonar tu voz, graba <strong style={{ color: "var(--text-primary)" }}>5 segundos</strong> hablando con normalidad. Consejos para mejor calidad:
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
                {[
                  ["Habla con tu cadencia natural", "No leas — improvisa una frase tuya"],
                  ["Ambiente silencioso", "Cierra puertas, apaga el aire acondicionado"],
                  ["Micrófono a 15-20 cm", "No demasiado cerca para evitar pops"],
                ].map(([t, s]) => (
                  <div key={t} style={{
                    display: "flex", gap: 10,
                    padding: "8px 10px",
                    background: "rgba(255,255,255,0.03)",
                    borderRadius: 6,
                  }}>
                    <I.Check size={12} style={{ color: "var(--accent-soft)", marginTop: 2, flexShrink: 0 }}/>
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t}</div>
                      <div className="caption" style={{ fontSize: 11 }}>{s}</div>
                    </div>
                  </div>
                ))}
              </div>
              <button className="btn-primary large" style={{ width: "100%", justifyContent: "center" }} onClick={() => setStep("record")}>
                <I.Mic size={12}/>
                Empezar a grabar
              </button>
            </div>
          )}

          {step === "record" && (
            <div className="fade-up" style={{ textAlign: "center", padding: "20px 0" }}>
              <MicOrb recording={recording} time={recTime}/>
              <div style={{ marginTop: 16, fontSize: 14, fontWeight: 500 }}>
                {recording ? `Grabando · ${recTime.toFixed(1)}s` : "Pulsa para grabar"}
              </div>
              <p className="muted" style={{ margin: "6px 0 24px", fontSize: 12 }}>
                {recording ? "Habla con tu cadencia natural" : "Necesitamos 5 segundos exactos"}
              </p>
              <BigWaveform active={recording} progress={recTime / 5}/>
              <div style={{ marginTop: 24, display: "flex", justifyContent: "center", gap: 10 }}>
                {!recording ? (
                  <button className="btn-primary large" onClick={() => setRecording(true)}>
                    <I.Mic size={12}/>
                    Grabar 5 segundos
                  </button>
                ) : (
                  <button className="btn large" onClick={() => { setRecording(false); setRecTime(0); }}>
                    <I.Pause size={12}/>
                    Detener
                  </button>
                )}
              </div>
            </div>
          )}

          {step === "review" && (
            <div className="fade-up">
              <div style={{
                padding: "14px 16px",
                background: "rgba(46,177,137,0.08)",
                borderRadius: 10,
                boxShadow: "0 0 0 0.5px rgba(94,216,166,0.30)",
                display: "flex", alignItems: "center", gap: 14,
                marginBottom: 18,
              }}>
                <span className="lg-tile lg" style={{ "--tint": "#2eb189" }}>
                  <I.Check size={15}/>
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Muestra capturada · 5.0 s</div>
                  <div className="caption">Calidad: <strong style={{ color: "var(--accent-soft)" }}>Excelente</strong> · SNR 38dB · cadencia natural</div>
                </div>
                <button className="btn-ghost" onClick={() => setStep("record")}>Re-grabar</button>
              </div>

              <div className="eyebrow" style={{ marginBottom: 8 }}>Prueba la voz</div>
              <textarea
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                rows={2}
                className="input"
                style={{ fontFamily: "var(--font-display)", fontSize: 14, lineHeight: 1.4 }}
              />
              <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                <button className="btn"><I.Play size={11}/> Reproducir muestra original</button>
                <button className="btn"><I.Volume size={11}/> Sintetizar este texto</button>
              </div>

              <div style={{ marginTop: 22, display: "flex", gap: 10 }}>
                <button className="btn" style={{ flex: 1 }} onClick={() => setStep("record")}>Atrás</button>
                <button className="btn-primary" style={{ flex: 1 }} onClick={() => setStep("name")}>
                  Continuar
                  <I.Chevron size={11}/>
                </button>
              </div>
            </div>
          )}

          {step === "name" && (
            <div className="fade-up">
              <div className="eyebrow" style={{ marginBottom: 6 }}>Nombre de la voz</div>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 18, fontSize: 14, height: 32 }}/>
              <div style={{
                padding: "12px 14px",
                background: "rgba(0,0,0,0.18)",
                borderRadius: 8,
                fontSize: 11.5,
                lineHeight: 1.5,
                color: "var(--text-secondary)",
                marginBottom: 20,
              }}>
                Esta voz quedará disponible en el selector del Generador y en Smart Shorts. La muestra y los embeddings se guardan localmente en <code style={{ fontSize: 11 }}>~/voice_clones/</code> · nunca salen de tu equipo.
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button className="btn" style={{ flex: 1 }} onClick={() => setStep("review")}>Atrás</button>
                <button className="btn-primary" style={{ flex: 1 }} onClick={() => setStep("done")}>
                  <I.Check size={11}/>
                  Guardar voz
                </button>
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="fade-up" style={{ textAlign: "center", padding: "30px 0" }}>
              <div style={{
                width: 64, height: 64, borderRadius: 999,
                margin: "0 auto 16px",
                background: "radial-gradient(ellipse at 30% 26%, rgba(255,255,255,0.85), rgba(255,255,255,0) 38%), radial-gradient(circle at 60% 70%, rgba(94, 216, 166, 0.80), rgba(46, 177, 137, 0) 65%), linear-gradient(165deg, #c9e8d8 0%, #5ed8a6 55%, #2eb189 100%)",
                color: "#042418",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 0 0 0.5px rgba(255,255,255,0.55), 0 0 28px -2px rgba(94, 216, 166, 0.80)",
                animation: "fade-up 360ms var(--ease-spring) both",
              }}>
                <I.Check size={28} strokeWidth={3}/>
              </div>
              <h2 className="display" style={{ margin: 0, fontSize: 22, fontWeight: 500 }}>"{name}" guardada</h2>
              <p className="muted" style={{ margin: "6px 0 22px", fontSize: 12.5 }}>
                Ya puedes seleccionarla en el Generador como voz narradora.
              </p>
              <button className="btn-primary large" onClick={onClose}>Hecho</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MicOrb({ recording, time }) {
  return (
    <div style={{
      width: 96, height: 96,
      margin: "0 auto",
      borderRadius: 999,
      background:
        "radial-gradient(ellipse at 30% 26%, rgba(255,255,255,0.55), rgba(255,255,255,0) 40%)," +
        (recording
          ? "radial-gradient(circle at 60% 70%, rgba(212, 98, 109, 0.65), rgba(180, 70, 80, 0) 65%), linear-gradient(165deg, #f5b8be 0%, #c8525e 55%, #8a3540 100%)"
          : "radial-gradient(circle at 60% 70%, rgba(212, 184, 90, 0.55), rgba(168, 138, 60, 0) 65%), linear-gradient(165deg, #f3e6b8 0%, #d4b85a 55%, #a88a3c 100%)"
        ),
      display: "flex", alignItems: "center", justifyContent: "center",
      color: recording ? "#fff" : "#3a2a05",
      boxShadow:
        "0 0 0 0.5px rgba(255,255,255,0.55), inset 0 -2px 4px rgba(0,0,0,0.25)," +
        (recording
          ? "0 0 36px -2px rgba(212, 98, 109, 0.85)"
          : "0 0 24px -2px rgba(212, 184, 90, 0.55)"),
      animation: recording ? "mic-pulse 1.6s ease-in-out infinite" : "none",
      transition: "background 280ms",
    }}>
      <I.Mic size={36}/>
      {/* Progress ring */}
      {recording && (
        <svg width="96" height="96" viewBox="0 0 96 96" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
          <circle cx="48" cy="48" r="44" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="3"
            strokeDasharray={`${(time/5) * 276} 276`} strokeLinecap="round"
            style={{ transition: "stroke-dasharray 100ms linear", filter: "drop-shadow(0 0 6px rgba(255,255,255,0.5))" }}
          />
        </svg>
      )}
    </div>
  );
}

function BigWaveform({ active, progress }) {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setTick(t => t + 1), 60);
    return () => clearInterval(i);
  }, [active]);
  const bars = Array.from({ length: 48 }, (_, i) => {
    if (!active) return 4;
    return 6 + Math.abs(Math.sin((i + tick * 0.7) * 0.4) * 22 + Math.sin((i + tick * 0.4) * 0.7) * 8 + Math.sin((i + tick) * 0.2) * 4);
  });
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center", gap: 3, height: 60,
      padding: "0 14px",
      background: "rgba(0,0,0,0.20)",
      borderRadius: 8,
      maxWidth: 380, margin: "0 auto",
      position: "relative",
      overflow: "hidden",
    }}>
      {bars.map((h, i) => {
        const isPast = i / bars.length < progress;
        return (
          <div key={i} style={{
            flex: 1, maxWidth: 4,
            height: h,
            background: isPast ? "linear-gradient(180deg, #f5b8be, #c8525e)" : "rgba(255,255,255,0.18)",
            borderRadius: 1.5,
            opacity: active ? 0.85 : 0.3,
            transition: "height 60ms ease-out",
          }}/>
        );
      })}
    </div>
  );
}

Object.assign(window, { VoiceCloneWizard });
