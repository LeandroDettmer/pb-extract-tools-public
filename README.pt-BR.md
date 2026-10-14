# pb-extract-tools

Read this in English: [README.md](README.md).

Ferramentas de linha de comando (`pbx`) que leem **a sua cópia** das pastas de cliente do Point Blank e exportam para formatos abertos (GLB, JSON, OGG, PNG, DDS). É uma ferramenta de estudo privada. Este repositório não contém arquivos do jogo.

## O que é

- Uma só entrada, `pbx`, que roda um exportador por comando. Os exportadores são scripts Node ESM simples. Dependências de runtime: `three`, `ffmpeg-static` e `sharp` (usado só pelo `bloodtex`).
- Todos os caminhos vêm de um módulo, `lib/paths.mjs`. Nenhum outro arquivo fixa pasta de cliente, `../..` ou o layout de saída.
- A saída vai para `./out` por padrão. As pastas do jogo são lidas no lugar e nunca são escritas.

## Requisitos

| Item | Versão | Para quê |
|---|---|---|
| Node.js | **22.7 ou mais novo** (usa remoção nativa de tipos TypeScript) | tudo |
| npm | qualquer recente | instalar |
| Python 3 + `capstone` (+ `pefile` para `re cross-text`) | opcional | comandos `re` e `shopdat` |
| ffmpeg | 6.x ou mais novo, trazido por `ffmpeg-static` (vem com 6.1.1) | `sound` e exportação OGG |

As ferramentas são desenvolvidas no Windows. Usa-se o lançador `py` no Windows e `python3` nos demais.

## Instalação

```bash
git clone https://github.com/LeandroDettmer/pb-extract-tools-public.git pb-extract-tools
cd pb-extract-tools
npm install
npm link          # opcional: deixa `pbx` disponível em qualquer pasta
```

## Início rápido

Você precisa de uma cópia de pelo menos um cliente (por exemplo o cliente 2017 "Kaybo", pasta `PBKaybo\GameData\Apps\PB`). Depois:

```bash
pbx init --clients "C:\Games\PB\Clients"        # ou direto na pasta de um cliente
pbx doctor                                       # o que funciona nesta máquina
pbx re pef-config                                # lê Script.i3Pack -> extracted/pef2017 (uma vez)
pbx unpack "C:\Games\PB\Clients\PBKaybo\GameData\Apps\PB\Pack\Weapon_AUG_A3.i3Pack" --out out/unpacked
pbx export batch weapons --only "^aug_a3"        # uma família de arma (base + skins); o batch lê só o PBCross
```

Onde a saída cai:

- `out/weapons/models/<id>.glb` e as texturas em `out/weapons/models/tex/<id>/`
- `out/weapons/models/index.json` (uma entrada por arma, com o cliente de origem)
- `out/unpacked/` para `unpack`; `extracted/` para os leitores `re`

Rode `pbx doctor` de novo depois de cada passo. Ele mostra quais grupos de comando funcionam nesta máquina.

> `export batch`, `anim3pv`, `anim1pv`, `weapon-anim`, `weaponfx`, `fxmesh`, `c5-bomb` e `headgear` leem só o cliente PBCross (desde 2026-10-13): sem fallback para 2017, 3.123, RU ou packs portáteis. Conteúdo que o PBCross não tem não é exportado (o plano de cliente único, item W3, ainda não está neste repositório).

## Comandos

Cada linha é um comando. "Precisa" lista os clientes que ele lê e se precisa de `--web` (o código do app web e dados do servidor).

A tabela completa de comandos (o que cada um faz, requisitos e exemplo) está no [README.md](README.md), na seção "Commands". `pbx help` lista os mesmos comandos a partir do código.

## Flags globais

Coloque estas flags **antes** do nome do grupo. Elas não são repassadas ao script, então o `--out` próprio de um script (por exemplo `unpack`) continua funcionando.

| Flag | Variável de ambiente | Chave no `pbx.config.json` | Padrão | O que é |
|---|---|---|---|---|
| `--clients <dir>` | `PB_CLIENTS` | `clients` | nenhum (obrigatório) | pasta que contém as pastas dos clientes |
| `--client <chave>=<dir>` (no `init`) | `PB_CLIENT_<CHAVE>` | `overrides.<chave>` | derivado | uma pasta de cliente, quando não estão todas sob uma raiz |
| `--out <dir>` | `PB_ASSETS` | `assets` | `./out` | saída dos assets (o que o cliente web carrega) |
| `--web <dir>` | `PB_WEB` | `web` | nenhum | pasta do projeto web que consome os assets (tem `src/`). Habilita os passos que leem ou escrevem nela |
| `--server <dir>` | `PB_SERVER` | `server` | nenhum | raiz do servidor com `server/` e `old/` (dados do servidor do jogo). Habilita os passos que leem nela |
| `--extracted <dir>` | `PB_EXTRACTED` | `extracted` | `./extracted` | JSON parseado que outros passos leem |
| `--snapshots <dir>` | `PB_SNAPSHOTS` | `snapshots` | `./snapshots` | snapshots para `snapshot` e `verify assets` |

Ordem: flag, depois variável de ambiente, depois `pbx.config.json`, depois o padrão. Caminhos relativos saem da pasta onde você roda o `pbx`. O `pbx init` grava caminhos absolutos.

Chaves de cliente: `kaybo` (2017), `br3123` (3.123), `cross`, `ru`, `portable`, `hyper`, `blackout`.

## Clientes

| Chave | Pasta sob a raiz de clientes | Versão | O que as ferramentas leem |
|---|---|---|---|
| `kaybo` | `PBKaybo\GameData\Apps\PB` | Point Blank 2017 (Kaybo) | referência de personagens, armas, sons, mapas e HUD. A maioria dos exportadores usa este |
| `br3123` | `PointBlank 3.123` | Point Blank 3.123 (BR) | conjuntos de animação dos personagens, armas de reserva, voz de rádio, dados da loja, textos de UI, colisão de mapa |
| `cross` | `PBCross` | Point Blank Cross | UI do Cross, ícones, música do lobby, showroom, marcas de clã, locais de bomba |
| `ru` | `PB RUSSIA` | Point Blank Russia | packs de reserva para `batch` e layouts de ragdoll |
| `portable` | `Point-Blank-Portable\3-PointBlank` | Point Blank Portable 3.1 | HUD de contagem regressiva, iluminação de reserva |
| `hyper` | `Point Blank Hyper` | Point Blank Hyper | ícone de patente do placar |
| `blackout` | `EpicBlackout` | EpicBlackout (2014) | janelas de UI clássica e imagens de marca |

A versão é um palpite pela pasta. Confirme no jogo antes de confiar numa exportação. `pbx doctor` mostra para qual pasta cada chave aponta.

## Cliente base (`--client`)

Exportadores que leem os originais de um cliente pegam o cliente de `baseClient(default)` em `lib/paths.mjs`. O default é o cliente que o exportador lê hoje, então nada muda sem pedido. Para ler outro, passe `--client <chave>` depois do comando, ou defina `PB_BASE_CLIENT=<chave>` para a execução toda (`pbx export sfx --client cross`). Chave desconhecida para o erro `--client <chave>: unknown client key`.

- **Trocam:** exportadores que leem um cliente só. `--client cross` lê `PBCross`.
- **Não trocam:** exportadores que leem vários clientes como fonte ou reserva, e os que já leem o Cross (`ui cross-*`, `ui clanmark`, `re cross-pef`). A tabela de status por comando está na seção em inglês acima.
- `surfaces` lê todas as pastas de cliente: não troca.

## Formatos de saída

| Saída | Formato | Quem grava |
|---|---|---|
| personagens e modelos de arma | GLB (glTF 2.0 binário) + texturas PNG + índice JSON | `export batch`, `anim3pv`, `anim1pv`, `c5-bomb`, `headgear`, `ui-idle` |
| texturas de modelo | DXT `.dds` ao lado do PNG | `model-dds`, `map-dds`, `env-ref`, `visual`, `cross-showroom` |
| geometria de mapa | `visual.glb`, `collision.glb` + `collision.json`, `surfaces.json`, `lighting.json`, `props.json` | `maps`, `visual`, `collision`, `surfaces`, `lighting`, `props`, `env-ref` |
| bibliotecas de clipes e dados | JSON (`index.json`, `ragdoll.json`, `weaponfx.json`, `ambient.json`) | `anim3pv`, `anim1pv`, `weapon-anim`, `weaponfx`, `ragdoll`, `ambient`, `sound-rsc` |
| sons | `.wav` (origem), `.ogg` (Vorbis, o que o navegador toca) | `sfx`, `charsfx`, `announce`, `c4-sfx`, `break-sfx`, `radio-voice`, `wav-to-ogg` (`sound convert`) |
| UI | atlas PNG + JSON (cenas, templates, textos, ligações Lua) | `ui *`, `classic-ui`, `clanmark`, `cross-icons` |
| código do web | `.ts` / `.json` gravados em `src/` com `--web`, senão em `out/generated/` (avisado) | `missions`, `titles`, `match-data`, `sound-rsc`, `fpscam` |
| dados brutos parseados | JSON em `extracted/` | `re pef-config`, `pef-json`, `unpack` (na pasta que você der) |

## Receitas

**Exportar o pipeline inteiro (simulação primeiro):**

```bash
pbx export all --client cross --dry-run  # lista os passos; marca os pulados e os que ficam de fora
pbx snapshot                             # copia o que a re-exportação em massa reescreve
pbx export all                           # roda em ordem; para no primeiro erro e mostra --from para retomar
pbx verify assets                        # regressões contra o snapshot
```

Um passo cujo cliente falta, ou que precisa de `--web` sem ele, é pulado com uma linha dizendo o motivo. A execução continua e termina com um resumo.

**Retomar depois de um erro:**

```bash
pbx export all --from weapons
```

## Solução de problemas

| Sintoma | Causa e correção |
|---|---|
| `pbx: Point Blank 2017 (Kaybo): missing "...", expected at "..."` | o caminho dentro do cliente está errado para esta versão. Confira a pasta ou rode `pbx init --clients <dir>` |
| `pbx: client not set (needs ...)` | nenhuma pasta de clientes configurada. Rode `pbx init --clients <dir>` |
| `pbx: not produced yet: "...extracted\pef2017...". Run pbx re pef-config first` | falta uma entrada parseada. Rode uma vez o passo `re` indicado |
| `pbx: needs --web <dir>` ou `needs --server <dir>` | o passo lê ou escreve código-fonte do app web ou dados do servidor. Passe a flag ou pule o passo |
| packs PFN1 são pulados | alguns packs de 2017 usam um formato que esta ferramenta não decodifica (PFN1). Packs de sniper e de alguns sons mantêm valores de reserva. O log diz quais |
| packs com caminhos internos `D:\...` falham ao descompactar | o pack guarda um caminho de build do disco do desenvolvedor (ex.: `UI_Main.i3Pack`). Leia em memória com `parsePack` / `readI3R2` de `i3pack/unpack.mjs`, em vez de descompactar no disco |
| `ffmpeg 5.x refused` / `needs >= 6` | o binário `ffmpeg` é antigo (o build de 2018 preenche o último bloco Vorbis). Rode `npm install` (usa o 6.1.1 incluído), ou aponte `FFMPEG` para um binário mais novo |
| comandos `re` falham com `No module named capstone` | instale Python 3 e `pip install capstone pefile`. Os comandos `re` são opcionais |
| `bloodtex` falha com `Cannot find package 'sharp'` | rode `npm install` |
| erro em `.mjs` com Node 22.7 ou mais antigo | atualize o Node. As ferramentas usam remoção nativa de TypeScript (flag `--experimental-transform-types`) |

## Checklist de uso seguro

- Leia `pbx help` e `pbx doctor` antes de tudo. Rode só comandos cuja coluna "Precisa" esteja atendida.
- Simulação primeiro: `pbx export all --dry-run`. Mostre a lista antes de uma exportação em massa.
- Snapshot antes de qualquer re-exportação em massa: `pbx snapshot`. Reverter: `pbx snapshot --restore`.
- Nunca rode `pbx export all` sem perguntar antes. Ele reescreve muitos arquivos em `out/`.
- Um asset só: `pbx export <nome>` (ex.: `pbx export sfx`). Confira antes a coluna "Precisa".
- Depois de exportar: `pbx verify assets`. Código de saída 1 significa regressão contra o snapshot.
- Não aceite um som ou efeito recriado antes de conferir o original em `PBKaybo\GameData\Apps\PB\Pack`.
- A maioria dos JSON exportados grava a origem (`source`, `tool`, `generated`). Mantenha esses campos.

## Legal

Este repositório **não contém assets do jogo, executáveis do jogo nem código decompilado**. As ferramentas só leem cópias das pastas do jogo que você possui. Point Blank, seus formatos e seus assets pertencem aos respectivos titulares (Zepetto). Use a saída para estudo privado e testes. Não redistribua os assets exportados.
