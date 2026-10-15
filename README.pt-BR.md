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
| Python 3 + `capstone` | opcional | `re pbdis` (precisa de `capstone`); `re shopdat` (Python 3) |
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

Você precisa de uma cópia de cada cliente que os passos usados leem. Por exemplo, o cliente 2017 "Kaybo" (pasta `PBKaybo\GameData\Apps\PB`) e o Point Blank Cross (pasta `PBCross`). A coluna "Precisa" da tabela de [Comandos](README.md#commands) (no README em inglês) diz qual cliente cada passo lê. Depois:

```bash
pbx init --clients "C:\Games\PB\Clients"        # ou direto na pasta de um cliente
pbx doctor                                       # o que funciona nesta máquina
pbx re pef-config                                # Kaybo: lê Script.i3Pack -> extracted/pef2017 (uma vez)
pbx unpack "C:\Games\PB\Clients\PBKaybo\GameData\Apps\PB\Pack\Weapon_AUG_A3.i3Pack" --out out/unpacked
pbx export batch weapons --only "^aug_a3"        # Cross: uma família de arma (base + skins)
```

Onde a saída cai:

- `out/weapons/models/<id>.glb` e as texturas em `out/weapons/models/tex/<id>/`
- `out/weapons/models/index.json` (uma entrada por arma, com o cliente de origem)
- `out/unpacked/` para `unpack`; `extracted/` para os leitores `re`

Rode `pbx doctor` de novo depois de cada passo. Ele mostra quais grupos de comando funcionam nesta máquina.

## Menu e visão ao vivo

![Gravação do terminal do menu pbx: abrir PB Extract Tools.cmd, definir a pasta dos clientes, rodar doctor (Point Blank Cross encontrado), escolher o cliente cross, simulação listando os passos, export all com a tabela de passos ao vivo, e sair](docs/pbx-menu.gif)

Prefere não digitar comandos? Abra o menu: `pbx menu`, ou `npm run menu`, ou dê duplo clique em `PB Extract Tools.cmd` no Windows. No macOS ou Linux rode `chmod +x "PB Extract Tools.sh"` uma vez e depois `"./PB Extract Tools.sh"`. O menu lista doctor, definir a pasta dos clientes, escolher um cliente, export all (simulação, ou a execução real após uma confirmação s/N), export de um passo, snapshot e restore, e help. Cada item roda o mesmo comando que você digitaria.

No terminal, `pbx export all` desenha uma tabela dos passos e a atualiza cerca de quatro vezes por segundo:

```
pbx export all --client cross --jobs 4  12:31
 3 run  batch            2:05  [batch] 31/70 chars/...
 4 wait c5-bomb                after: batch
 2 ok   cross-pef        0:41
12 ok · 4 cached · 3 running · 0 failed
```

- `run` mostra a última linha de saída do passo. `wait` mostra os passos dos quais ele espera. `skip` mostra o motivo. `cached` é um passo cujas entradas e saídas não mudaram (veja "Execuções incrementais" em Receitas).
- Listas longas mostram primeiro os passos em execução, com falha e os próximos em espera, e depois uma linha `... N more`.
- Cada passo grava a saída completa em `logs/export-all/<passo>.log`. A pasta vem de `--logs <dir>`, `PB_LOGS`, da chave `logs` do `pbx.config.json` ou de `./logs`. Cada execução reescreve os logs dos passos que ela roda.
- Em caso de falha, a tabela para, saem as últimas 30 linhas do log do passo que falhou e depois a linha `--from` para retomar.
- Ctrl+C para os passos em execução e mostra o cursor de novo.
- `--plain`, um pipe ou CI dão a saída simples: linhas `[passo]` com `--jobs` acima de 1, a saída do próprio passo com `--jobs 1`. Com `--jobs 1` e sem terminal a saída não é capturada, então nenhum arquivo de log é gravado.

## Comandos

A tabela completa de comandos (o que cada um faz, requisitos e exemplo) está no [README.md](README.md), na seção "Commands". `pbx help` lista os mesmos comandos a partir do código.

## Flags globais

Coloque estas flags **antes** do nome do grupo. Elas não são repassadas ao script, então o `--out` próprio de um script (por exemplo `unpack`) continua funcionando.

| Flag | Variável de ambiente | Chave no `pbx.config.json` | Padrão | O que é |
|---|---|---|---|---|
| `--clients <dir>` | `PB_CLIENTS` | `clients` | nenhum (obrigatório) | pasta que contém as pastas dos clientes |
| `--client <chave>=<dir>` (no `init`) | `PB_CLIENT_<CHAVE>` | `overrides.<chave>` | derivado | uma pasta de cliente, quando não estão todas sob uma raiz |
| `--out <dir>` | `PB_ASSETS` | `assets` | `./out` | saída dos assets (o que o cliente web carrega) |
| `--web <dir>` | `PB_WEB` | `web` | nenhum | pasta do projeto web que consome os assets (tem `src/`). Habilita os passos que leem ou escrevem nela |
| `--server <dir>` | `PB_SERVER` | `server` | nenhum | raiz do servidor com `server/` (dados de runtime), `db/init/001_init.sql` (seed do banco, layout público) e `old/` opcional (fontes antigas, seed do banco do layout privado). Habilita os passos que leem nela |
| `--extracted <dir>` | `PB_EXTRACTED` | `extracted` | `./extracted` | JSON parseado que outros passos leem |
| `--snapshots <dir>` | `PB_SNAPSHOTS` | `snapshots` | `./snapshots` | snapshots para `snapshot` e `verify assets` |
| `--logs <dir>` | `PB_LOGS` | `logs` | `./logs` | um log de saída por passo do `export all` (veja [Menu e visão ao vivo](#menu-e-visão-ao-vivo)) |

Ordem: flag, depois variável de ambiente, depois `pbx.config.json`, depois o padrão. Caminhos relativos saem da pasta onde você roda o `pbx`. O `pbx init` grava caminhos absolutos.

Chaves de cliente: `kaybo` (2017), `br3123` (3.123), `cross`, `ru`, `portable`, `hyper`, `blackout`.

## Nível do PNG e cache de texturas

Os exportadores de modelos (`export batch`, `export headgear`, `export model-dds`) gravam cada textura como PNG. Duas coisas afetam isso:

- `PB_PNG_LEVEL` (só por variável de ambiente, padrão `9`): nível zlib do PNG. `9` grava os mesmos bytes de sempre, então o sha da saída não muda. `6` codifica mais rápido, mas grava PNGs com bytes diferentes e um pouco maiores: compare a saída por pixels, não por sha. Medido em `export batch --skins` (Cross): PNGs somam 586 MB no 9 e 590 MB no 6; batch 52 s no 9 e 32 s no 6 (cache frio). Valores de 0 a 8 também valem; qualquer outro para com uma linha de erro.
- Cache de texturas em `<extracted>/cache/tex/*.bin`: cada textura tem como chave um hash dos texels de origem, do tamanho máximo, do modo de alpha e do `PB_PNG_LEVEL`. Um passo ou execução seguinte copia o PNG guardado em vez de decodificar e codificar de novo. Medido: `export batch --skins` em 24 s com o cache quente contra 52 s a frio, mesma saída. Pode apagar o cache a qualquer momento (o custo é codificar de novo). Ele cresce com o número de texturas diferentes.

## Clientes

| Chave | Pasta sob a raiz de clientes | Versão | O que as ferramentas leem |
|---|---|---|---|
| `kaybo` | `PBKaybo\GameData\Apps\PB` | Point Blank 2017 (Kaybo) | tabelas PEF de 2017 (`re pef-config`), cenas Lua, janela de resultado de respawn, HUD, auditoria da loja de 2017 |
| `br3123` | `PointBlank 3.123` | Point Blank 3.123 (BR) | dados de armas (`export weapons`), dados da loja (`re shopdat`), UI de cenas e templates, ícones de itens, arte de carregamento |
| `cross` | `PBCross` | Point Blank Cross | o padrão da maioria dos passos: personagens, armas, mapas, sons, UI e ícones do Cross, showroom, locais de bomba, PEF (`re cross-pef`) |
| `ru` | `PB RUSSIA` | Point Blank Russia | nenhum passo lê por padrão. `--client ru` em um passo que segue `--client` (veja abaixo) não foi testado |
| `portable` | `Point-Blank-Portable\3-PointBlank` | Point Blank Portable 3.1 | HUD de contagem regressiva (`ui hud-countdown`) |
| `hyper` | `Point Blank Hyper` | Point Blank Hyper | ícone de patente do placar (`ui hyper-rank`) |
| `blackout` | `EpicBlackout` | EpicBlackout (2014) | janelas de UI clássica e imagens de marca (`ui classic-ui`, `ui epic-brand`) |

A versão é um palpite pela pasta. Confirme no jogo antes de confiar numa exportação. `pbx doctor` mostra para qual pasta cada chave aponta.

**Obtendo o cliente.** Este repositório não inclui nenhum cliente. Para obter uma cópia do Point Blank Cross, pesquise `PointBlank Cross` no YouTube. Use apenas uma cópia que você tenha o direito de usar, e coloque sob a raiz de clientes como `PBCross`. Não há links de download aqui.

**Outros clientes.** As ferramentas foram feitas e testadas com o Point Blank Cross. Outros clientes do Point Blank usam os mesmos formatos i3Engine, então podem ser suportados adaptando as ferramentas. Veja [Outros clientes (não Cross)](#outros-clientes-não-cross) para o que funciona hoje. Assistentes de código com IA podem ajudar bastante: aponte para este README, os comandos, os formatos dos packs e a pasta do seu cliente.

## Cliente base (`--client`)

Exportadores que leem os originais de um cliente pegam o cliente de `baseClient(default)` em `lib/paths.mjs`. O default é o cliente que o exportador lê hoje, então nada muda sem pedido. Para ler outro, passe `--client <chave>` depois do comando, ou defina `PB_BASE_CLIENT=<chave>` para a execução toda (`pbx export sfx --client cross`). Chave desconhecida para o erro `--client <chave>: unknown client key`.

Como a troca funciona:

- **`export all --client <chave>`** (ou `PB_BASE_CLIENT`) roda o pipeline de um cliente. Cada passo marcado "(`--client`)" na tabela do README em inglês lê esse cliente. Passos que leem cliente fixo ficam de fora, e a simulação os lista. Passos que precisam de dois clientes também ficam de fora.
- **Comandos avulsos.** Um script que chama `baseClient` também aceita `--client` quando roda sozinho. Por exemplo, `pbx export sfx --client kaybo` lê os packs de 2017. O `export all` não o roda para esse cliente.
- **Saídas.** Passos que gravam pastas por cliente usam a chave no caminho (por exemplo `out/<chave>/weapons/`). Os outros gravam na raiz compartilhada `out/` ou numa pasta `cross` fixa. Veja [Outros clientes (não Cross)](#outros-clientes-não-cross).
- O texto de origem dentro do JSON exportado (campos `source`) ainda cita a pasta original, por exemplo `PBCross`.

A tabela completa de status por comando está no README em inglês, seção "Base client".

## Outros clientes (não Cross)

O que funciona hoje para um cliente diferente do Cross. Dito com clareza. Nada aqui foi testado com outro cliente, e nenhum passo tem garantia de funcionar.

**Pasta de saída.** `export all --client <chave>` precisa de `--out` próprio para qualquer chave que não seja `cross`. Sem ele, a execução para com erro, e assim um segundo cliente não sobrescreve a saída do Cross. Dê um `--out` para cada cliente também nos comandos avulsos. `--dry-run` não faz a checagem, já que não grava nada.

**Tabelas PEF.** `pbx re cross-pef --client <chave>` grava `extracted/pef-<chave>/br/`. Os passos que leem tabelas PEF pegam essa pasta pela mesma chave. O leitor é o do Cross (`pef/export-cross.mjs`). O leitor de 2017 (`re pef-config`) usa outro layout (PFN3 no deslocamento `0x162`). Nada confere a saída de outro cliente contra o Cross. Compare antes de usar.

**O que ainda bloqueia outros clientes:**

1. **Nomes fixos de pack e de arquivo.** Muitos passos citam arquivos do Cross ou do Brasil diretamente: `Sound_voice_Announce`, `Sound_Weapon_C4`, `UI_Showroom`, `UI_Loading`, `Chara_ClanMark*`, `String_Brazil.lua`, as tabelas `*_Brazil` de itens e missões, `Gunplay.ttf`. Um cliente sem o arquivo falha com a linha `missing`. Um cliente com o mesmo nome e outro conteúdo exporta outros dados.
2. **Famílias de personagem.** `SWAT_Male` e `SWAT_Female` estão fixos em `batch`, `anim3pv` e `ui-idle`. Outros clientes podem usar outros conjuntos de personagens.
3. **Passos de dois clientes.** `ui scenes`, `ui templates`, `ui atlas`, `ui loading` e `ui hud-2017` leem as pastas de 3.123 e de 2017 ao mesmo tempo. A checagem de `needs` com uma chave só não expressa isso, então o `export all` nunca os roda para um cliente só.
4. **Passos fixos no Cross.** Os passos marcados "não" na tabela do README em inglês leem o Cross, e `export all --client <chave>` os deixa de fora. Rode-os avulsos só com um cliente cujos arquivos batam com o Cross.
5. **Chaves em `lib/paths.mjs`.** Uma chave nova em `CLIENTS` só mapeia uma pasta. Cada passo ainda precisa das verificações acima. O [CLAUDE.md](CLAUDE.md) lista os lugares a conferir.

## Formatos de saída

| Saída | Formato | Quem grava |
|---|---|---|
| personagens e modelos de arma | GLB (glTF 2.0 binário) + texturas PNG + índice JSON | `export batch`, `anim3pv`, `anim1pv`, `c5-bomb`, `headgear`, `ui-idle` |
| texturas de modelo | DXT `.dds` ao lado do PNG | `model-dds`, `map-dds`, `env-ref`, `visual`, `cross-showroom` |
| geometria de mapa | `visual.glb`, `collision.glb` + `collision.json`, `surfaces.json`, `lighting.json`, `props.json` | `maps`, `visual`, `collision`, `surfaces`, `lighting`, `props`, `env-ref` |
| bibliotecas de clipes e dados | JSON (`index.json`, `ragdoll.json`, `weaponfx.json`, `ambient.json`) | `anim3pv`, `anim1pv`, `weapon-anim`, `weaponfx`, `ragdoll`, `ambient`, `sound-rsc` |
| sons | `.wav` (origem), `.ogg` (Vorbis, o que o navegador toca) | `sfx`, `weapon-sfx`, `charsfx`, `announce`, `c4-sfx`, `break-sfx`, `radio-voice`, `wav-to-ogg` (`sound convert`) |
| UI | atlas PNG + JSON (cenas, templates, textos, ligações Lua) | `ui *`, `classic-ui`, `clanmark`, `cross-icons` |
| código do web | `.ts` / `.json` gravados em `src/` com `--web`, senão em `out/generated/` (avisado) | `missions`, `titles`, `ai`, `match-data`, `sound-rsc`, `fpscam` |
| dados brutos parseados | JSON em `extracted/` | `re pef-config`, `re cross-pef`, `pef-json`, `unpack` (na pasta que você der) |

## Dados de arma e sons de arma

Três comandos geram sons de arma. Use isto para escolher um:

- **`pbx export weapons`**: os dados de arma para o cliente web (`weapons.json`, dos dados de itens do servidor e do `Weapon.pef` do Cross). Também grava os clipes de som do loadout padrão, com papéis adivinhados. `--no-sfx` pula os clipes. `--all-sfx` grava todos os packs de som do Cross. Precisa de `--server`.
- **`pbx export weapon-sfx`**: só os clipes de som, sem os dados de arma. Os papéis são adivinhados, e o índice é `weapons/sfx/index.json`.
- **`pbx export sfx`**: as mesmas armas, mas os clipes são nomeados pelos packs do Cross, então nenhum papel é adivinhado. Grava `weapons/sfx/pb2017.json`, que diz quando a IA de cada arma toca cada clipe. Lê o `weapons.json`, então rode antes o `export weapons`.

## Receitas

**Exportar o pipeline inteiro (simulação primeiro):**

```bash
pbx export all --client cross --dry-run  # lista os passos; marca os pulados e os que ficam de fora
pbx snapshot                             # copia o que a re-exportação em massa reescreve
pbx export all                           # roda os passos; para no primeiro erro e mostra --from para retomar
pbx verify assets                        # regressões contra o snapshot
```

Um passo cujo cliente falta, ou que precisa de `--web` sem ele, é pulado com uma linha dizendo o motivo. A execução continua e termina com um resumo.

**Rodar passos em paralelo:**

```bash
pbx export all --jobs 4                  # padrão: no máximo 4, cores / 3, 2 GB de RAM por passo
pbx export all --jobs 1                  # um passo por vez, na ordem de ALL em pbx.mjs
```

Um passo começa quando os passos de que depende terminam (`after` em `ALL`, em `pbx.mjs`). A simulação mostra a lista de espera de cada passo. Com mais de um job, cada linha de saída começa com `[passo]`. Depois de um erro nenhum passo novo começa. Os que estão rodando terminam, e aí a execução para. Os pools internos de cada passo (`export maps`, `export batch`, `export headgear`, os passos de verify e de ogg) usam `PB_JOBS` workers: se `PB_JOBS` não estiver definido, `max(2, cores / --jobs)`, ou seja 3 cada numa máquina de 12 cores com 4 passos.

**Execuções incrementais:**

```bash
pbx export all --dry-run                 # cada passo: [cached], ou [run: motivo]
pbx export all                           # roda de novo sem mudanças: todo passo em cache, em segundos
pbx export all --force                   # roda todos os passos
pbx export all --force-step weapons,maps # roda estes, e os passos que esperam por eles
```

Um passo fica em cache quando nada que ele lê ou escreve mudou desde a última execução boa: o script e os arquivos locais que ele importa ou nomeia, os argumentos, os caminhos e as configurações `PB_*`, a pasta do cliente, as árvores de `--server` e de `src` do `--web` (por stat), as pastas de saída (por stat) e os passos de que ele espera. O estado fica em `<extracted>/.pbx-state.json`. Passo com erro ou interrompido não é gravado, então roda de novo. Passo cuja saída foi apagada ou editada roda de novo. O `snapshot` só roda quando algum passo de exportação mudou. Os passos de verify, audit e ogg rodam quando algum passo de exportação rodou. `--jobs` não muda o estado.

Limites: script que lê um arquivo cujo nome monta em tempo de execução não é rastreado. Um leitor de `--web` roda mais uma vez depois que um passo do web reescreveu o `src/`.

**Retomar depois de um erro:**

```bash
pbx export all --from weapons
```

## Solução de problemas

| Sintoma | Causa e correção |
|---|---|
| `pbx: Point Blank 2017 (Kaybo): missing "...", expected at "..."` | o caminho dentro do cliente está errado para esta versão. Confira a pasta ou rode `pbx init --clients <dir>` |
| `pbx: Point Blank Cross not set (needs ...)` | nenhuma pasta de clientes (ou override) configurada para esse cliente. Rode `pbx init --clients <dir>` |
| `pbx: not produced yet: "...extracted\pef-cross\br\...". Run pbx re cross-pef first` | falta uma entrada parseada. Rode o passo `re` que a mensagem indica: `pbx re cross-pef` (Cross), `pbx re pef-config` (2017), `pbx re cross-pef --client <chave>` (outras chaves) |
| `pbx: --client <chave> writes the shared out/ folders: give it its own --out <dir>` | `export all` com um cliente que não é o Cross e sem `--out`. Passe `--out <dir>` (ou defina `PB_ASSETS`) |
| `pbx: --client <chave>: unknown client key` | a chave não está em `CLIENTS` (`lib/paths.mjs`). Use uma das chaves listadas em [Chaves de cliente](#flags-globais) |
| `pbx: needs --web <dir>` ou `needs --server <dir>` | o passo lê ou escreve código-fonte do app web ou dados do servidor. Passe a flag ou pule o passo |
| packs PFN1 são pulados | alguns packs de 2017 usam um formato que esta ferramenta não decodifica (PFN1). Packs de sniper e de alguns sons mantêm valores de reserva. O log diz quais |
| packs com caminhos internos `D:\...` falham ao descompactar | o pack guarda um caminho de build do disco do desenvolvedor (ex.: `UI_Main.i3Pack`). Leia em memória com `parsePack` / `readI3R2` de `i3pack/unpack.mjs`, em vez de descompactar no disco |
| `ffmpeg 5.x refused` / `needs >= 6` | o binário `ffmpeg` é antigo (o build de 2018 preenche o último bloco Vorbis). Rode `npm install` (usa o 6.1.1 incluído), ou aponte `FFMPEG` para um binário mais novo |
| comandos `re` falham com `No module named capstone` | instale Python 3 e `pip install capstone`. Os comandos `re` são opcionais |
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
