import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Sparkles, CheckCircle, Download, FileJson, Copy, AlertTriangle } from 'lucide-react';
import { GoogleGenAI, Type } from '@google/genai';

export default function CreateSite() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [mapsLink, setMapsLink] = useState('');
  const [successData, setSuccessData] = useState<{filename: string, id: number, data: any} | null>(null);
  const [copied, setCopied] = useState(false);

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mapsLink) {
      setError('Por favor, insira um link do Google Maps.');
      return;
    }
    
    setIsLoading(true);
    setError('');

    try {
      // 1. Expand the URL if it's a short link
      let finalUrl = mapsLink;
      let placeNameHint = '';
      try {
        const expandRes = await fetch('/api/expand-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ url: mapsLink })
        });
        
        if (expandRes.ok) {
          const expandData = await expandRes.json();
          if (expandData.url) {
            finalUrl = expandData.url;
            
            // Try to extract place name from the expanded URL
            const match = finalUrl.match(/\/place\/([^\/]+)/);
            if (match && match[1]) {
              placeNameHint = decodeURIComponent(match[1].replace(/\+/g, ' '));
            }
          }
        }
      } catch (e) {
        console.warn('Failed to expand URL, using original', e);
      }

      // 2. Get API Key from settings or environment
      let apiKey = '';
      
      try {
        const settingsRes = await fetch('/api/settings', {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (settingsRes.ok) {
          const settings = await settingsRes.json();
          if (settings.gemini_api_key) {
            apiKey = settings.gemini_api_key;
            console.log("Using API key from database settings");
          }
        }
      } catch (e) {
        console.error("Error fetching settings:", e);
      }
      
      if (!apiKey) {
        // Fallback to environment variable
        apiKey = import.meta.env.VITE_GEMINI_API_KEY || (process.env as any).GEMINI_API_KEY || '';
        if (apiKey) {
          console.log("Using API key from environment variables");
        }
      }

      if (!apiKey) {
        setError('Chave da API do Gemini não configurada. Por favor, configure-a na página de Configurações.');
        setIsLoading(false);
        return;
      }

      // 3. Analyze with AI
      const ai = new GoogleGenAI({ apiKey: apiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `Você é um especialista em extração de dados.
Você recebeu o seguinte link do Google Maps: ${finalUrl}
${placeNameHint ? `\nDica: O nome do estabelecimento extraído da URL parece ser "${placeNameHint}".` : ''}

Sua missão é OBRIGATÓRIA:
1. Analise cuidadosamente a URL fornecida e a dica de nome (se houver) para identificar o estabelecimento.
2. Descubra EXATAMENTE qual é o estabelecimento real (nome, nicho, endereço, telefone).
3. Se o link for genérico, quebrado, ou se você NÃO TIVER 100% DE CERTEZA de qual é o estabelecimento exato, você DEVE definir "success" como false e preencher o "errorMessage" explicando que não foi possível identificar o local e pedindo para o usuário verificar o link.
4. Se você encontrou o estabelecimento com sucesso, defina "success" as true e extraia os dados reais: Nome da empresa, telefone (apenas números com DDD), endereço completo e cidade.
5. Identifique o NICHO exato (ex: barbearia, lanchonete, clínica, restaurante).
6. Crie uma DESCRIÇÃO detalhada do negócio.
7. Liste os principais serviços oferecidos (ou que fazem sentido para o nicho), separados por vírgula.

RETORNE APENAS UM JSON VÁLIDO com a seguinte estrutura exata (sem formatação markdown como \`\`\`json):
{
  "success": true/false,
  "errorMessage": "mensagem de erro se success for false",
  "name": "Nome da Empresa",
  "phone": "Telefone",
  "address": "Endereço Completo",
  "city": "Cidade",
  "description": "Descrição",
  "services": "Serviços"
}

NÃO INVENTE DADOS. Se não souber ou não encontrar o local exato, retorne success: false.`,
        config: {
          // Removido o uso de tools (googleMaps/googleSearch) pois causa erro 429 em contas gratuitas.
          // A IA consegue extrair os dados diretamente da URL expandida.
        }
      });

      if (response.text) {
        let extractedData;
        try {
          // Remove markdown formatting if present
          const cleanText = response.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          extractedData = JSON.parse(cleanText);
        } catch (parseError) {
          console.error("JSON Parse Error:", parseError, "Raw text:", response.text);
          throw new Error("A resposta da IA não estava em um formato válido. Tente novamente.");
        }
        
        if (!extractedData.success) {
          setError(extractedData.errorMessage || 'Não foi possível identificar o estabelecimento a partir deste link. Por favor, verifique o link.');
          setIsLoading(false);
          return;
        }

        // 4. Save the extracted data
        const saveRes = await fetch('/api/analyze/save', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            ...extractedData,
            map_link: mapsLink
          })
        });

        let saveData;
        try {
          saveData = await saveRes.json();
        } catch (e) {
          throw new Error(`Erro no servidor ao salvar os dados (Status: ${saveRes.status}). O servidor pode estar indisponível ou ocorreu um erro interno.`);
        }
        
        if (!saveRes.ok) throw new Error(saveData.error || 'Erro ao salvar dados');

        setSuccessData({ filename: saveData.filename, id: saveData.id, data: extractedData });
      }
    } catch (err: any) {
      console.error(err);
      
      let friendlyError = err.message || 'Verifique se o link é válido ou tente novamente.';
      
      // Check for Gemini Quota Error (429)
      if (friendlyError.includes('429') || friendlyError.includes('RESOURCE_EXHAUSTED') || friendlyError.includes('quota')) {
        friendlyError = 'Limite de cota atingido (Erro 429). A ferramenta do Google Maps no Gemini tem limites diários. IMPORTANTE: Se você trocou a chave no Render, lembre-se de atualizá-la também no menu "Configurações" deste painel, pois a chave salva lá tem prioridade.';
      } else if (friendlyError.includes('API_KEY_INVALID') || friendlyError.includes('invalid API key')) {
        friendlyError = 'Chave de API inválida. Por favor, verifique a chave configurada nas Configurações.';
      }

      setError(`Erro ao analisar o link com IA: ${friendlyError}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadJson = async () => {
    if (successData) {
      try {
        const res = await fetch(`/api/analyze/download/${successData.filename}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Falha ao baixar arquivo');
        
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = successData.filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      } catch (error) {
        console.error('Download error:', error);
        alert('Erro ao baixar o arquivo JSON.');
      }
    }
  };

  const handleCopyJson = async () => {
    if (successData) {
      try {
        await navigator.clipboard.writeText(JSON.stringify(successData.data, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  };

  if (successData) {
    return (
      <div className="max-w-4xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden border border-zinc-100">
          <div className="bg-emerald-600 py-8 px-8 text-center text-white">
            <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-3xl font-bold mb-2">Análise Concluída!</h2>
            <p className="text-emerald-100">Os dados foram extraídos e salvos com sucesso.</p>
          </div>

          <div className="p-8 sm:p-10">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
              <div className="space-y-6">
                <div>
                  <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Empresa</h4>
                  <p className="text-xl font-bold text-zinc-900">{successData.data.name}</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Telefone</h4>
                    <p className="text-zinc-900">{successData.data.phone || 'N/A'}</p>
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Cidade</h4>
                    <p className="text-zinc-900">{successData.data.city || 'N/A'}</p>
                  </div>
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Endereço</h4>
                  <p className="text-zinc-900">{successData.data.address || 'N/A'}</p>
                </div>
              </div>
              <div className="space-y-6">
                <div>
                  <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Descrição</h4>
                  <p className="text-sm text-zinc-600 line-clamp-3">{successData.data.description || 'N/A'}</p>
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Serviços</h4>
                  <p className="text-sm text-zinc-600 line-clamp-2">{successData.data.services || 'N/A'}</p>
                </div>
              </div>
            </div>
            
            <div className="bg-zinc-50 rounded-xl p-6 mb-10 border border-zinc-200">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <FileJson className="w-5 h-5 text-emerald-600" />
                  <span className="font-medium text-zinc-900">{successData.filename}</span>
                </div>
                <button
                  onClick={handleCopyJson}
                  className="text-sm font-medium text-emerald-600 hover:text-emerald-700 flex items-center gap-1"
                >
                  {copied ? <><CheckCircle className="w-4 h-4" /> Copiado</> : <><Copy className="w-4 h-4" /> Copiar JSON</>}
                </button>
              </div>
              <pre className="bg-zinc-900 text-emerald-400 p-4 rounded-lg text-xs overflow-x-auto max-h-48">
                {JSON.stringify(successData.data, null, 2)}
              </pre>
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <button
                onClick={handleDownloadJson}
                className="w-full sm:w-auto inline-flex items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-xl shadow-sm text-white bg-emerald-600 hover:bg-emerald-700 transition-colors"
              >
                <Download className="w-5 h-5 mr-2" />
                Baixar JSON
              </button>
              <button
                onClick={() => navigate('/sites')}
                className="w-full sm:w-auto inline-flex items-center justify-center px-8 py-3 border border-zinc-200 text-base font-medium rounded-xl text-zinc-700 bg-white hover:bg-zinc-50 transition-colors"
              >
                Ver Todas Análises
              </button>
              <button
                onClick={() => {
                  setSuccessData(null);
                  setMapsLink('');
                }}
                className="w-full sm:w-auto inline-flex items-center justify-center px-8 py-3 text-base font-medium rounded-xl text-zinc-500 hover:text-zinc-700 transition-colors"
              >
                Nova Análise
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-6">
      <div className="md:flex md:items-center md:justify-between mb-8">
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-bold leading-7 text-zinc-900 sm:text-3xl sm:truncate">
            Analisar Link do Google Maps
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Cole o link abaixo para extrair automaticamente os dados do estabelecimento e salvar em formato JSON.
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border-l-4 border-red-400 p-4 mb-6 rounded-r-md">
          <div className="flex items-start">
            <div className="flex-shrink-0">
              <AlertTriangle className="h-5 w-5 text-red-400" />
            </div>
            <div className="ml-3 flex-1">
              <p className="text-sm text-red-700 font-medium">{error}</p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setIsLoading(false);
                  }}
                  className="text-sm font-bold text-red-800 hover:text-red-900 underline"
                >
                  Limpar erro e tentar novamente
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <form onSubmit={handleAnalyze} className="bg-white shadow rounded-lg p-6">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6 mb-8">
          <div className="flex items-start">
            <div className="flex-shrink-0 mt-1">
              <Sparkles className="h-6 w-6 text-emerald-600" />
            </div>
            <div className="ml-4 flex-1">
              <h3 className="text-lg font-medium text-emerald-900">Extração com Inteligência Artificial</h3>
              <p className="mt-1 text-sm text-emerald-700">
                Nossa IA vai buscar os dados reais do local e estruturá-los em um arquivo JSON.
              </p>
              <div className="mt-4 flex flex-col sm:flex-row gap-3">
                <input
                  type="url"
                  value={mapsLink}
                  onChange={(e) => setMapsLink(e.target.value)}
                  placeholder="https://maps.app.goo.gl/..."
                  required
                  className="flex-1 focus:ring-emerald-500 focus:border-emerald-500 block sm:text-sm border-emerald-300 rounded-md shadow-sm px-3 py-2 border bg-white"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="pt-5 border-t border-zinc-200 mt-6">
          <div className="flex flex-col sm:flex-row sm:justify-end gap-3">
            <button
              type="button"
              onClick={() => navigate('/sites')}
              className="w-full sm:w-auto bg-white py-2 px-4 border border-zinc-300 rounded-md shadow-sm text-sm font-medium text-zinc-700 hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 order-2 sm:order-1"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="w-full sm:w-auto inline-flex justify-center items-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-emerald-600 hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 disabled:opacity-50 order-1 sm:order-2"
            >
              {isLoading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Analisando...
                </>
              ) : (
                'Analisar e Extrair Dados'
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
