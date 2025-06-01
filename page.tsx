'use client';
import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import { supabase } from '@/lib/supabase';
import { encrypt } from '@/utils/aes';

/* ---------- Tipler ---------- */
type Subuser = { id: string; username: string };

export default function QrPage() {
  /* === STATE === */
  const [codeCount, setCodeCount] = useState(1);
  const [price, setPrice] = useState(0);
  const [printName, setPrintName] = useState('*İşletme Adı*');
  const [outputMode, setOutputMode] = useState<'ekran' | 'termal'>('termal'); // ★ YENİ
  const [status, setStatus] = useState('QR kod adedi ve fiyat giriniz.');
  const [urls, setUrls] = useState<string[]>([]);
  const [masterUrl, setMasterUrl] = useState<string | null>(null);
  const [shouldRenderQR, setShouldRenderQR] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [flashErr, setFlashErr] = useState(false);   // hata uyarısı 2 sn kırmızı yanıp sönecek



  /* === SESSION === */
  const [userId, setUserId] = useState('');          // owner id
  const [subuserId, setSubuserId] = useState<string | null>(null);
  const [qrid, setQrid] = useState('');
  const [username, setUsername] = useState('');
  const [ownerName, setOwnerName] = useState('');    // işletme adı
  const [activeCashier, setActiveCashier] = useState<Subuser | null>(null);

  /* === SUBUSER LIST & MODAL === */
  const [subusers, setSubusers] = useState<Subuser[]>([]);
  const [isSwitchOpen, setIsSwitchOpen] = useState(false);
  const [selSubId, setSelSubId] = useState('');
  const [subPwd, setSubPwd] = useState('');

  /* === REFS === */
  const masterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

 useEffect(() => {
  const fetchUser = async () => {
    const { data: authData } = await supabase.auth.getUser();
    const userId = authData?.user?.id;

    if (!userId) {
      window.location.href = '/login';
      return;
    }

    const { data: userData } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (!userData) {
      window.location.href = '/login';
      return;
    }

    setUserId(userData.id);
    setQrid(userData.qrid);
    setUsername(userData.username);
    setOwnerName(userData.username);

    // Kasiyer listesini yükle (admin moddaysa)
    if (!activeCashier) {
      const { data: subuserList } = await supabase
        .from('subusers')
        .select('id, username')
        .eq('owner_id', userData.id);
      setSubusers(subuserList || []);
    }
  };

  fetchUser();
}, []);

  /* === ADMIN ise kasiyerleri çek === */
  useEffect(() => {
    const load = async () => {
      if (!userId || subuserId) return;          // kasiyerdeyken listeleme
      const { data, error } = await supabase
        .from('subusers')
        .select('id,username')
        .eq('owner_id', userId)
        .order('username');
      if (!error) setSubusers(data || []);
    };
    load();
  }, [userId, subuserId]);
  

  /* === CORE RPC: Son kodu + rezerve === */
  const reserveCodes = async (qrOwnerId: string, count: number) => {
    const { data, error } = await supabase.rpc('reserve_qr_codes', {
      p_user_id: qrOwnerId,
      p_increment: count,
    });
    if (error) throw error;
    return data as number; // başlangıç kodu
  };

  /* === SUBUSER SEÇ === */
  const getTargetSubuser = (): string => {
  if (activeCashier?.id) return activeCashier.id;
  throw new Error('Kasiyer seçilmeden QR üretilemez. Menüden “Kullanıcı Değiştir” ile kasiyer seç.');
};

  /* ---------- KASİYER DEĞİŞTİR ---------- */
 const switchToSubuser = async () => {
  if (!selSubId || !subPwd) return alert('Kullanıcı ve şifre giriniz');

  const { data, error } = await supabase
    .from('subusers')
    .select('id, username')
    .eq('id', selSubId)
    .eq('password', subPwd)
    .maybeSingle();

  if (error) return alert('Hata: ' + error.message);
  if (!data) return alert('Şifre hatalı');

  setSubuserId(data.id); // ❌ artık gerek yok → setActiveCashier(data)
  setUsername(data.username);
  setActiveCashier(data); // ✅ kasiyer oturumu bellekte tutuluyor
  setIsSwitchOpen(false);
  setSubPwd('');
  setStatus(`👋 ${data.username} olarak devam ediyorsun`);
};


  /* ---------- KASİYERİ KAPAT ---------- */
  const closeSubuser = () => {
  setActiveCashier(null);
  setUsername(ownerName || '(Admin)');
  setStatus('Admin moduna döndün');
};
  /* === Otomatik yazdır === */
useEffect(() => {
  if (!masterUrl || outputMode !== 'termal') return;   // ★ şart eklendi
  // Küçük bir gecikme, canvas'ların çizilmesine fırsat verir
  const t = setTimeout(() => handlePrint(), 300);
  return () => clearTimeout(t);    // sonraki üretimde temizle
}, [masterUrl, outputMode]);  

  /* === GENERATE === */
  const handleGenerate = async () => {
    if (isGenerating) return;
    setIsGenerating(true);

    try {
       // ✅ Ön kontrol: kasiyer seçili mi?
    if (!activeCashier?.id) {
      setStatus('⚠️ Kasiyer seçilmeden QR üretilemez. Menüden “Kullanıcı Değiştir” ile kasiyer seç.');
      setFlashErr(true);
      setTimeout(() => setFlashErr(false), 2000);
      return;
    }
      // ---- Validasyon ----
      if (codeCount < 1) {
        setStatus('En az 1 adet girmelisin.');
        return;
      }
      if (price <= 0) {
        setStatus('Fiyat sıfır veya daha küçük olamaz.');
        setFlashErr(true);                 // kırmızı + animate
      setTimeout(() => setFlashErr(false), 2000);  // 2 sn sonra normale dön
      return;
      }

      // ---- Tarihler ----
      const today = new Date();
      const formattedDate = today
        .toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' })
        .replace(/\//g, '.');
      const todayISO = today.toISOString().split('T')[0];

      // ---- 1) Son kodu atomik rezerve et ----
      const baseNumber = await reserveCodes(userId, codeCount);

      // ---- 2) URL’leri üret ----
      const urlsLocal: string[] = [];
      let lastPlainCode = '';
      for (let i = 1; i <= codeCount; i++) {
        const plain = `${qrid}${baseNumber + i}-${formattedDate}`;
        urlsLocal.push(encrypt(plain));
        lastPlainCode = plain;
      }

      // ---- 3) subuser_stats güncelle ----
      const targetSubuser = getTargetSubuser();
      const { error: statsErr } = await supabase.rpc('increment_subuser_stats', {
        p_subuser_id: targetSubuser,
        p_date: todayISO,
        p_count: codeCount,
        p_price: price * codeCount,
        p_last_code: lastPlainCode,
      });
      if (statsErr) throw statsErr;

      // ---- 4) UI’yi güncelle ----
      setUrls(urlsLocal);
      const encoded = urlsLocal.map(encodeURIComponent).join(',');
      const master = `https://qrw-web.vercel.app/?codes=${encoded}`;
      if (master.length > 2000) {
        setStatus('URL çok uzun, daha az kod üret.');
        return;
      }
      setMasterUrl(master);
      setShouldRenderQR(true);

      setStatus(`✅ ${codeCount} adet üretildi. Ücret: ${price * codeCount} TL`);
      setCodeCount(1);
    } catch (err: any) {
      console.error(err);
      setStatus(`Hata: ${err.message ?? 'Bilinmeyen'}`);
    } finally {
      setTimeout(() => setIsGenerating(false), 1000);
    }
  };

  /* === QR ÇİZ === */
  useEffect(() => {
    const draw = async () => {
      for (let i = 0; i < urls.length; i++) {
        const canvas = canvasRefs.current[i];
        if (canvas) await QRCode.toCanvas(canvas, urls[i], { width: 180, errorCorrectionLevel: 'M' });
      }
      if (masterUrl && masterCanvasRef.current) {
        await QRCode.toCanvas(masterCanvasRef.current, masterUrl, { width: 256, errorCorrectionLevel: 'M' });
      }
    };
    if (shouldRenderQR) {
      draw();
      setShouldRenderQR(false);
    }
  }, [urls, masterUrl, shouldRenderQR]);
  /* === Klavye kısayolları: Enter / + / - === */
useEffect(() => {
  const listener = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    // Input’larda yazı yazarken devre dışı bırak
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'Enter') {
      e.preventDefault();
      handleGenerate();
    } else if (e.key === '+') {
      setCodeCount((c) => c + 1);
    } else if (e.key === '-') {
      setCodeCount((c) => Math.max(1, c - 1));
    }
  };

  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}, [handleGenerate]);
  /* === PRINT === */
  const handlePrint = () => {
  if (outputMode === 'ekran') return; // ★ ekrandayken sessizce çık
  window.print();
};

  /* === JSX === */
  return (
    <main className="min-h-screen font-inter
  bg-gradient-to-br from-blue-300 via-teal-50 to-green-300
  dark:from-slate-800 dark:via-slate-900 dark:to-black
  p-6">
      {/* Hamburger */}
      <button
        onClick={() => setMenuOpen((p) => !p)}
        className="fixed top-4 left-6 z-[9999] bg-gray-800 text-white px-3 py-2 rounded-lg print:hidden"
      >
        ☰
      </button>

      {/* Menü Overlay ve Sidebar */}
<div
  className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-300 ${
    menuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
  }`}
  onClick={() => setMenuOpen(false)}
>
  <div
    className={`absolute top-0 left-0 h-full w-72 bg-white shadow-lg p-4 space-y-4 z-50 transform transition-transform duration-300 ${
      menuOpen ? 'translate-x-0' : '-translate-x-full'
    }`}
    onClick={(e) => e.stopPropagation()}
  >
    {/* Menü başlığı sağda */}
    <div className="flex justify-end">
      <h2 className="text-xl font-bold text-black">Menü</h2>
    </div>

    <button
      onClick={() => (window.location.href = '/report')}
      className="w-full bg-blue-600 text-white font-semibold py-2 rounded"
    >
      📊 Raporlar-Ayarlar
    </button>

    <button
      onClick={() => setIsSwitchOpen(true)}
      className="w-full bg-yellow-500 text-white font-semibold py-2 rounded"
    >
      🔄 Kullanıcı Değiştir
    </button>

    <button
      onClick={() => {
        localStorage.clear();
        window.location.href = '/login';
      }}
      className="w-full bg-red-600 text-white font-semibold py-2 rounded"
    >
      🚪 Oturumu Kapat
    </button>

    <div className="text-center text-gray-700 text-sm mt-4 leading-snug">
      İşletme: <span className="font-semibold">{ownerName}</span><br />
      Kullanıcı: <span className="font-semibold">{username}</span>
    </div>
  </div>
</div>


      {/* Grid */}
      <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-6">
       {/* Form */}
<div className="
  bg-white/70 backdrop-blur-md shadow-xl rounded-2xl
  ring-1 ring-black/10 dark:ring-white/10
  p-6 space-y-5 transition
  print:hidden">

 <div className="relative flex items-center justify-center">
  {/* Sol taraf: kullanıcı adı */}
  <div className="absolute left-0 top-1/2 -translate-y-1/2 text-xs text-green-600 font-semibold px-2">
    👤 {username}
  </div>

  {/* Ortadaki başlık */}
  <h1 className="text-2xl font-bold text-gray-800 text-center">
    QrW
  </h1>

  {/* Sağdaki ComboBox */}
  <select
    value={outputMode}
    onChange={(e) => setOutputMode(e.target.value as 'ekran' | 'termal')}
    className="absolute right-0 top-1/2 -translate-y-1/2 border rounded px-3 py-1 text-sm text-black"
    title="Çıktı Modu"
  >
    <option value="ekran">Ekran QR</option>
    <option value="termal">Termal yazıcı</option>
  </select>
</div>

  {/* durum satırı (değişmedi) */}
  <p
    className={`text-center text-lg font-semibold ${
      flashErr ? 'text-red-600 animate-pulse' : 'text-black'
    }`}
  >
    {status}
  </p>


          {/* İşletme */}
          <label className="block text-sm font-medium text-gray-700">
            İşletme Adı
            <input
              className="w-full border rounded px-3 py-2 text-black mt-1"
              value={printName}
              onChange={(e) => setPrintName(e.target.value.slice(0, 20))}
            />
          </label>

          {/* Fiyat / Adet */}
          <div className="grid grid-cols-2 gap-4">
            <label className="block text-sm font-medium text-gray-700">
              Fiyat (TL)
              <input
                type="number"
                min="0"
                step="5"
                className="w-full border rounded px-3 py-2 text-black mt-1"
                value={price}
                onChange={(e) => setPrice(Number(e.target.value))}
              />
            </label>

            <label className="block text-sm font-medium text-gray-700">
              QR Adedi
              <input
                type="number"
                min="1"
                className="w-full border rounded px-3 py-2 text-center text-black mt-1"
                value={codeCount}
                onChange={(e) => setCodeCount(Number(e.target.value))}
              />
            </label>
          </div>

          {/* +/-/C */}
          <div className="flex gap-2">
            <button onClick={() => setCodeCount((p) => Math.max(1, p - 1))} className="w-full bg-blue-600 text-white py-2 rounded">
              -
            </button>
            <button onClick={() => setCodeCount((p) => p + 1)} className="w-full bg-blue-600 text-white py-2 rounded">
              +
            </button>
            <button onClick={() => setCodeCount(1)} className="w-full bg-red-400 text-white py-2 rounded">
              C
            </button>
          </div>

          {/* Üret / Yazdır */}
          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="w-full relative bg-green-600 text-white font-bold py-3 rounded overflow-hidden disabled:opacity-70"
          >
                      {isGenerating && (
              <div className="absolute inset-0 overflow-hidden rounded-lg">
                <div className="
                  h-full w-full
                  bg-gradient-to-r from-transparent via-white/70 to-transparent
                  animate-[loading_1.2s_linear_infinite]
                " />
              </div>
            )}
            <span className="relative z-10">{isGenerating ? 'Üretiliyor…' : 'Üret'}</span>
          </button>
          <button onClick={handlePrint} disabled={!urls.length} className="w-full bg-indigo-600 text-white font-bold py-3 rounded">
            Yazdır
          </button>
        </div>

        {/* Ana QR */}
        <div className="bg-white rounded-xl shadow p-6 print:hidden">
          {masterUrl && (
            <div className="text-center">
              <h2 className="text-lg font-semibold mb-2 text-black">Ana QR Kod</h2>
               {/* ▼ YENİ: kullanıcıya talimat */}
                <p className="text-base text-black-700 mb-2">
                📲  QR KODLARINIZ İÇİN KODU TARAYIN!
                </p>
              <canvas ref={masterCanvasRef} className="mx-auto" />
              <p className="text-sm mt-2 text-black">
                {printName} - Ana Kod
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Yazdırma görünümü */}
      <div className="hidden print:block print:w-[58mm] print:p-0">
        {urls.map((u, i) => (
          <div
            key={i}
            className="mb-8 w-full flex flex-col items-center"
            style={{ transform: 'translateX(-2mm)', marginBottom: '10mm' }}   // sol kaydırma korundu
          >
            {/* ▲ YENİ: sıra numarası */}
            <p className="text-base mb-0">{`QR KOD ${i + 1}`}
              
            </p>
            

            {/* QR canvas */}
            <canvas
              ref={(el) => {
                canvasRefs.current[i] = el;
              }}
            />

            {/* işletme adı */}
            <p className="text-base mt-0">{printName}</p>
          </div>
        ))}
      </div>

      {/* ---------- KULLANICI DEĞİŞTİR MODALI ---------- */}
      {isSwitchOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[9999]">
          <div className="bg-white p-6 rounded-xl shadow-lg w-80 space-y-4">
            <h3 className="text-lg font-semibold text-gray-800">Kasiyer Seç</h3>

            <select
              className="w-full border rounded px-3 py-2 text-black"
              value={selSubId}
              onChange={(e) => setSelSubId(e.target.value)}
            >
              <option value="">Seçiniz…</option>
              {subusers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.username}
                </option>
              ))}
            </select>

            <input
              placeholder="Şifre"
              type="password"
              className="w-full border rounded px-3 py-2 text-black"
              value={subPwd}
              onChange={(e) => setSubPwd(e.target.value)}
            />

            <div className="flex justify-end gap-2">
              <button onClick={() => setIsSwitchOpen(false)} className="bg-gray-400 text-white px-4 py-2 rounded">
                Vazgeç
              </button>
              <button onClick={switchToSubuser} className="bg-green-600 text-white px-4 py-2 rounded">
                Devam
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
