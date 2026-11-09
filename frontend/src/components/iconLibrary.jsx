// iconLibrary.jsx
// A free, searchable icon library built on lucide-react.
// Exposes:
//   ICON_LIST      – array of { name, keywords } for the picker
//   Icon           – <Icon name="FileText" size={18} /> resolver (safe fallback)
//   IconPicker     – searchable popover button for choosing an icon
//
// Add more names to LIB below and they instantly show up in the picker.
import { useState, useRef, useEffect } from 'react';
import {
  // general / docs
  FileText, File, Files, FileCheck, FileWarning, FilePlus, Folder, FolderOpen,
  ClipboardList, ClipboardCheck, Clipboard, BookOpen, Book, Notebook, StickyNote,
  Newspaper, Receipt, Scroll, Bookmark, Tag, Tags, Paperclip, Pin,
  // alerts / status
  AlertTriangle, AlertCircle, AlertOctagon, Info, HelpCircle, ShieldAlert, ShieldCheck,
  Shield, Ban, OctagonAlert, CircleAlert, TriangleAlert, Bug, Flame, Siren,
  // check / flow
  CheckCircle2, CheckCircle, Check, CheckSquare, XCircle, X, Circle, CircleDot,
  ListChecks, ListTodo, List, ListOrdered, Workflow, GitBranch, GitMerge, GitFork,
  Split, Milestone, Flag, FlagTriangleRight, Target, Crosshair, Route, Signpost,
  // arrows / motion
  ArrowRight, ArrowLeft, ArrowUp, ArrowDown, ArrowRightLeft, ArrowUpDown,
  CornerDownRight, CornerUpRight, MoveRight, Redo2, Undo2, RefreshCw, RotateCw,
  Repeat, Shuffle, Play, Pause, FastForward, SkipForward, ChevronsRight,
  // people / org
  User, Users, UserCheck, UserPlus, UserCog, UserX, Contact, IdCard, Building,
  Building2, Briefcase, Handshake, HeartHandshake, PhoneCall, Mail, MessageSquare,
  MessageCircle, Send, AtSign, Bell, Megaphone,
  // logistics / warehouse / transport
  Truck, Forklift, Package, PackageCheck, PackageOpen, PackagePlus,
  PackageSearch, Boxes, Box, Container, Warehouse, ShoppingCart, Ship, Anchor,
  Plane, Train, TrainFront, Car, Bus, Bike, Fuel, MapPin, Map, Navigation, Globe,
  Route as RouteIcon, Weight, Scale, Ruler, Gauge, Timer, Hourglass,
  // money / business
  DollarSign, Coins, CreditCard, Wallet, Banknote, PiggyBank, TrendingUp,
  TrendingDown, BarChart3, LineChart, PieChart, Percent, Calculator, Landmark,
  // tools / settings / tech
  Settings, Settings2, Wrench, Hammer, Cog, SlidersHorizontal, Filter, Database,
  Server, HardDrive, Cpu, Cloud, CloudUpload, CloudDownload, Wifi, Plug, Power,
  Lock, Unlock, Key, KeyRound, Fingerprint, ScanLine, QrCode, Barcode,
  // time / calendar
  Clock, Clock3, Calendar, CalendarClock, CalendarCheck, CalendarDays, History,
  // misc
  Star, Heart, ThumbsUp, ThumbsDown, Award, Trophy, Medal, Gem, Sparkles, Zap,
  Lightbulb, Eye, EyeOff, Search, Plus, Minus, Trash2, Edit3, Save, Download,
  Upload, Share2, Link2, ExternalLink, Copy, Printer, Camera, Image, Layers,
  Grid3x3, LayoutGrid, Columns3, Rows3, PanelsTopLeft, Component, Puzzle,
  Cog as CogIcon, Factory, Recycle, Leaf, Droplet, Thermometer, Snowflake,
  Sun, Moon, Compass, Home, Phone, Smartphone, Monitor, Laptop, Cpu as CpuIcon
} from 'lucide-react';

// name -> component
const LIB = {
  FileText, File, Files, FileCheck, FileWarning, FilePlus, Folder, FolderOpen,
  ClipboardList, ClipboardCheck, Clipboard, BookOpen, Book, Notebook, StickyNote,
  Newspaper, Receipt, Scroll, Bookmark, Tag, Tags, Paperclip, Pin,
  AlertTriangle, AlertCircle, AlertOctagon, Info, HelpCircle, ShieldAlert, ShieldCheck,
  Shield, Ban, OctagonAlert, CircleAlert, TriangleAlert, Bug, Flame, Siren,
  CheckCircle2, CheckCircle, Check, CheckSquare, XCircle, X, Circle, CircleDot,
  ListChecks, ListTodo, List, ListOrdered, Workflow, GitBranch, GitMerge, GitFork,
  Split, Milestone, Flag, FlagTriangleRight, Target, Crosshair, Route, Signpost,
  ArrowRight, ArrowLeft, ArrowUp, ArrowDown, ArrowRightLeft, ArrowUpDown,
  CornerDownRight, CornerUpRight, MoveRight, Redo2, Undo2, RefreshCw, RotateCw,
  Repeat, Shuffle, Play, Pause, FastForward, SkipForward, ChevronsRight,
  User, Users, UserCheck, UserPlus, UserCog, UserX, Contact, IdCard, Building,
  Building2, Briefcase, Handshake, HeartHandshake, PhoneCall, Mail, MessageSquare,
  MessageCircle, Send, AtSign, Bell, Megaphone,
  Truck, Forklift, Package, PackageCheck, PackageOpen, PackagePlus,
  PackageSearch, Boxes, Box, Container, Warehouse, ShoppingCart, Ship, Anchor,
  Plane, Train, TrainFront, Car, Bus, Bike, Fuel, MapPin, Map, Navigation, Globe,
  Weight, Scale, Ruler, Gauge, Timer, Hourglass,
  DollarSign, Coins, CreditCard, Wallet, Banknote, PiggyBank, TrendingUp,
  TrendingDown, BarChart3, LineChart, PieChart, Percent, Calculator, Landmark,
  Settings, Settings2, Wrench, Hammer, Cog, SlidersHorizontal, Filter, Database,
  Server, HardDrive, Cpu, Cloud, CloudUpload, CloudDownload, Wifi, Plug, Power,
  Lock, Unlock, Key, KeyRound, Fingerprint, ScanLine, QrCode, Barcode,
  Clock, Clock3, Calendar, CalendarClock, CalendarCheck, CalendarDays, History,
  Star, Heart, ThumbsUp, ThumbsDown, Award, Trophy, Medal, Gem, Sparkles, Zap,
  Lightbulb, Eye, EyeOff, Search, Plus, Minus, Trash2, Edit3, Save, Download,
  Upload, Share2, Link2, ExternalLink, Copy, Printer, Camera, Image, Layers,
  Grid3x3, LayoutGrid, Columns3, Rows3, PanelsTopLeft, Component, Puzzle,
  Factory, Recycle, Leaf, Droplet, Thermometer, Snowflake,
  Sun, Moon, Compass, Home, Phone, Smartphone, Monitor, Laptop
};

// Extra search keywords so people can find icons by meaning (AZ + EN).
const KEYWORDS = {
  FileText: 'sənəd document məlumat info', AlertTriangle: 'risk təhlükə warning xəbərdarlıq',
  Truck: 'yük avtomobil daşıma nəqliyyat transport', Package: 'paket yük bağlama',
  Warehouse: 'anbar depo warehouse', Container: 'konteyner yük',
  CheckCircle2: 'təsdiq ok tamam done approve', XCircle: 'imtina rədd xəta reject',
  Users: 'komanda işçi people team', User: 'istifadəçi şəxs person',
  Clock: 'vaxt saat time', Calendar: 'təqvim tarix date',
  DollarSign: 'pul məbləğ ödəniş money', Truck2: 'nəqliyyat',
  Ship: 'gəmi dəniz sea', Train: 'qatar dəmir yolu rail', Plane: 'təyyarə hava air',
  ShieldAlert: 'təhlükəsizlik risk security', Lock: 'kilid təhlükəsizlik lock',
  Search: 'axtar yoxla search', Flag: 'bayraq mərhələ milestone flag',
  Workflow: 'axın proses flow', GitBranch: 'şaxə budaq branch qərar',
  Milestone: 'mərhələ nöqtə', Building2: 'ofis şirkət bina office',
  Forklift: 'yükləyici forklift', Boxes: 'yüklər qutular',
};

export const ICON_LIST = Object.keys(LIB).map(name => ({
  name,
  keywords: (name.replace(/([A-Z])/g, ' $1') + ' ' + (KEYWORDS[name] || '')).toLowerCase()
}));

export const DEFAULT_ICON = 'FileText';

export function Icon({ name, size = 18, className, style, strokeWidth = 2 }) {
  const Cmp = LIB[name] || LIB[DEFAULT_ICON];
  return <Cmp size={size} className={className} style={style} strokeWidth={strokeWidth} />;
}

export function hasIcon(name) { return !!LIB[name]; }

/* ---------- Searchable picker ---------- */
export function IconPicker({ value, onChange, color }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const term = q.trim().toLowerCase();
  const list = term
    ? ICON_LIST.filter(i => i.keywords.includes(term)).slice(0, 120)
    : ICON_LIST.slice(0, 120);

  return (
    <div className="icon-picker" ref={ref}>
      <button
        type="button"
        className="icon-picker-trigger"
        onClick={() => setOpen(o => !o)}
        title="İkon seç"
      >
        <Icon name={value || DEFAULT_ICON} size={16} style={color ? { color } : undefined} />
        <span className="icon-picker-caret">▾</span>
      </button>

      {open && (
        <div className="icon-picker-pop">
          <div className="icon-picker-search">
            <Search size={14} />
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="İkon axtar (məs. yük, risk, təsdiq)"
            />
          </div>
          <div className="icon-picker-grid">
            {list.map(i => (
              <button
                type="button"
                key={i.name}
                className={`icon-picker-cell ${i.name === value ? 'sel' : ''}`}
                title={i.name}
                onClick={() => { onChange(i.name); setOpen(false); setQ(''); }}
              >
                <Icon name={i.name} size={17} />
              </button>
            ))}
            {list.length === 0 && <div className="icon-picker-empty">Tapılmadı</div>}
          </div>
        </div>
      )}
    </div>
  );
}
