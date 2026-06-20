import { useRef, useState } from "react";
import { UploadCloud, FileText, X, Play } from "lucide-react";

interface ChatInputProps {
  onAnalyze: (text: string) => void;
  isAnalyzing: boolean;
}

export default function ChatInput({ onAnalyze, isAnalyzing }: ChatInputProps) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function loadFile(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setText(content);
    };
    reader.readAsText(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  }

  function clearFile() {
    setFileName(null);
    setText("");
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className={`relative border-2 border-dashed rounded-xl transition-colors cursor-pointer ${
          dragOver
            ? "border-violet-400 bg-violet-500/10"
            : "border-white/10 hover:border-white/20 bg-white/[0.02]"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !fileName && fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.log,.csv,.json"
          className="hidden"
          onChange={handleFileChange}
        />
        {fileName ? (
          <div className="flex items-center gap-3 px-4 py-3">
            <FileText size={18} className="text-violet-400 shrink-0" />
            <span className="text-sm text-white/80 truncate flex-1">{fileName}</span>
            <button
              onClick={(e) => { e.stopPropagation(); clearFile(); }}
              className="p-1 rounded-md hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-5 px-4 text-center select-none">
            <UploadCloud size={24} className="text-white/30" />
            <p className="text-sm text-white/40">
              Drop a chat log file here, or click to browse
            </p>
            <p className="text-xs text-white/25">.txt, .log, .csv, .json</p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-white/10" />
        <span className="text-xs text-white/30 uppercase tracking-widest">or paste chat below</span>
        <div className="h-px flex-1 bg-white/10" />
      </div>

      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setFileName(null); }}
        placeholder={`Paste chat log here. Accepts common formats:\n[00:01:23] username: message\n(1:23:45) username: message\n00:00:05 username: hello\n1714000000 username: hi`}
        className="w-full h-44 resize-none rounded-xl bg-white/[0.03] border border-white/10 text-sm text-white/80 placeholder-white/20 px-4 py-3 focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.05] transition-colors font-mono leading-relaxed"
        spellCheck={false}
      />

      <button
        onClick={() => text.trim() && onAnalyze(text)}
        disabled={!text.trim() || isAnalyzing}
        className="flex items-center justify-center gap-2 w-full py-3 rounded-xl font-semibold text-sm transition-all bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white shadow-lg shadow-violet-900/30"
      >
        <Play size={15} className={isAnalyzing ? "animate-spin" : ""} />
        {isAnalyzing ? "Analyzing…" : "Analyze Chat"}
      </button>
    </div>
  );
}
