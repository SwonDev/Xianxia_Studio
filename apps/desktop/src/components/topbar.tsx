import { useQuery } from '@tanstack/react-query';
import { Activity, Cpu, HardDrive } from 'lucide-react';
import { tauri, type SidecarState } from '@/lib/tauri';
import { cn } from '@/lib/utils';

interface ServiceStatus {
  ok: boolean;
  label: string;
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        'inline-block w-1.5 h-1.5 rounded-full',
        ok ? 'bg-jade-400 shadow-[0_0_6px_rgba(82,183,136,0.7)]' : 'bg-paper-400',
      )}
    />
  );
}

export function Topbar() {
  const { data: hw } = useQuery({
    queryKey: ['hardware'],
    queryFn: tauri.detectHardware,
    staleTime: 60_000,
  });

  const { data: sidecars } = useQuery<SidecarState>({
    queryKey: ['sidecars'],
    queryFn: tauri.getSidecarState,
    refetchInterval: 4000,
  });
  const services: ServiceStatus[] = [
    { ok: sidecars?.ollama === 'running', label: 'Ollama' },
    { ok: sidecars?.python === 'running', label: 'Python' },
    { ok: sidecars?.node === 'running', label: 'Node' },
    { ok: sidecars?.comfyui === 'running', label: 'ComfyUI' },
  ];

  return (
    <header className="h-14 shrink-0 border-b border-border/50 bg-background/80 backdrop-blur flex items-center px-6 gap-6 relative z-20">
      <div className="flex-1" />

      {/* Hardware quick info */}
      {hw && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5" title={hw.cpu_brand}>
            <Cpu className="w-3.5 h-3.5 text-gold-400/70" />
            <span>{hw.cpu_cores} cores</span>
          </div>
          <div className="flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5 text-gold-400/70" />
            <span>{hw.available_ram_gb.toFixed(1)} / {hw.total_ram_gb.toFixed(1)} GB</span>
          </div>
        </div>
      )}

      {/* Services dots */}
      <div className="flex items-center gap-3 text-xs">
        {services.map((s) => (
          <div
            key={s.label}
            className="flex items-center gap-1.5 text-muted-foreground"
            title={`${s.label} · ${s.ok ? 'running' : 'stopped'}`}
          >
            <StatusDot ok={s.ok} />
            <span>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Pulse */}
      <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-obsidian-800 border border-border/50">
        <Activity className="w-3 h-3 text-gold-400" />
        <span className="text-[10.5px] text-paper-200 font-medium tracking-wide uppercase">Idle</span>
      </div>
    </header>
  );
}
