import discord
from discord.ext import commands
from discord import app_commands, ui
import os
from dotenv import load_dotenv
import asyncio

# 環境変数の読み込み
load_dotenv()
TOKEN = os.getenv('DISCORD_TOKEN')
# 募集内容を表示するチャンネルID (未設定の場合は環境変数から読み込むか、コード内で指定)
TARGET_CHANNEL_ID = os.getenv('TARGET_CHANNEL_ID')

if not TOKEN:
    print("エラー: .envファイルにDISCORD_TOKENを設定してください。")
    exit()

# インテントの設定
intents = discord.Intents.default()
intents.message_content = True
intents.guilds = True
intents.members = True

# ボットのセットアップ
class FF14RecruitBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix='!', intents=intents)

    async def setup_hook(self):
        # 永続的なViewを登録（再起動後もボタンが動くようにするため）
        self.add_view(RecruitTriggerView())
        # 既存の募集用Viewも本来はDBから復元してadd_viewすべきですが、
        # 簡易実装のため、起動後に作成されたものは動きますが、再起動前のボタンは無効になる場合があります。
        # 本格運用ではDBが必要です。
        await self.tree.sync()

bot = FF14RecruitBot()

# ---------------------------------------------------------
# データ管理 (簡易的なメモリ内保存)
# 本格運用にはSQLiteなどのデータベース推奨
# ---------------------------------------------------------
recruitments = {}

class RecruitmentData:
    def __init__(self, host_id, title, date, time, max_roles, vc_id=None):
        self.host_id = host_id
        self.title = title
        self.date = date
        self.time = time
        self.max_roles = max_roles  # {'Tank': 2, 'Healer': 2, 'DPS': 4}
        self.current_roles = {'Tank': [], 'Healer': [], 'DPS': []} # IDのリスト
        self.vc_id = vc_id
        self.is_active = True

    def add_participant(self, user_id, role):
        # 既に参加しているかチェックして削除（ロール変更対応）
        self.remove_participant(user_id)
        
        if len(self.current_roles[role]) < self.max_roles[role]:
            self.current_roles[role].append(user_id)
            return True
        return False

    def remove_participant(self, user_id):
        for role in self.current_roles:
            if user_id in self.current_roles[role]:
                self.current_roles[role].remove(user_id)
                return True
        return False

    def get_status_str(self, role):
        return f"{len(self.current_roles[role])}/{self.max_roles[role]}"

    def is_full(self, role):
        return len(self.current_roles[role]) >= self.max_roles[role]

# ---------------------------------------------------------
# UIコンポーネント: 募集操作パネル (参加・キャンセル・終了)
# ---------------------------------------------------------
class RecruitmentPanel(ui.View):
    def __init__(self, message_id):
        super().__init__(timeout=None)
        self.message_id = message_id
        self.update_buttons()

    def get_data(self):
        return recruitments.get(self.message_id)

    def update_buttons(self):
        data = self.get_data()
        if not data:
            self.clear_items()
            return

        # ボタンの定義を動的に更新
        # Tank
        tank_btn = [x for x in self.children if isinstance(x, ui.Button) and x.custom_id == f"role_tank_{self.message_id}"]
        if not tank_btn:
            self.add_item(RoleButton(role="Tank", message_id=self.message_id))
        
        # Healer
        healer_btn = [x for x in self.children if isinstance(x, ui.Button) and x.custom_id == f"role_healer_{self.message_id}"]
        if not healer_btn:
            self.add_item(RoleButton(role="Healer", message_id=self.message_id))

        # DPS
        dps_btn = [x for x in self.children if isinstance(x, ui.Button) and x.custom_id == f"role_dps_{self.message_id}"]
        if not dps_btn:
            self.add_item(RoleButton(role="DPS", message_id=self.message_id))

        # Cancel & Close (これらは固定で追加済みだが、ラベル更新が必要な場合はここで処理)

class RoleButton(ui.Button):
    def __init__(self, role, message_id):
        self.role = role
        self.message_id = message_id
        super().__init__(
            style=discord.ButtonStyle.primary if role == "Tank" else discord.ButtonStyle.success if role == "Healer" else discord.ButtonStyle.danger,
            label=f"{role} ?",
            custom_id=f"role_{role.lower()}_{message_id}",
            row=0
        )
        # 初期化時にラベルを設定
        self.refresh_label()

    def refresh_label(self):
        data = recruitments.get(self.message_id)
        if data:
            count = len(data.current_roles[self.role])
            max_c = data.max_roles[self.role]
            self.label = f"{self.role} {count}/{max_c}"
            self.disabled = count >= max_c

    async def callback(self, interaction: discord.Interaction):
        data = recruitments.get(self.message_id)
        if not data:
            await interaction.response.send_message("この募集は既に終了しているか、データが見つかりません。", ephemeral=True)
            return

        # 参加処理
        success = data.add_participant(interaction.user.id, self.role)
        
        if success:
            await update_recruitment_message(interaction, self.message_id)
            await interaction.followup.send(f"{self.role}枠に参加しました！", ephemeral=True)
        else:
            await interaction.response.send_message("その枠は満員です。", ephemeral=True)

class LeaveButton(ui.Button):
    def __init__(self, message_id):
        super().__init__(style=discord.ButtonStyle.secondary, label="参加取消", custom_id=f"leave_{message_id}", row=1)
        self.message_id = message_id

    async def callback(self, interaction: discord.Interaction):
        data = recruitments.get(self.message_id)
        if not data:
            await interaction.response.send_message("データが見つかりません。", ephemeral=True)
            return

        if data.remove_participant(interaction.user.id):
            await update_recruitment_message(interaction, self.message_id)
            await interaction.followup.send("参加を取り消しました。", ephemeral=True)
        else:
            await interaction.response.send_message("参加していません。", ephemeral=True)

class CloseButton(ui.Button):
    def __init__(self, message_id):
        super().__init__(style=discord.ButtonStyle.danger, label="募集終了", custom_id=f"close_{message_id}", row=1)
        self.message_id = message_id

    async def callback(self, interaction: discord.Interaction):
        data = recruitments.get(self.message_id)
        if not data:
            await interaction.response.send_message("データが見つかりません。", ephemeral=True)
            return

        if interaction.user.id != data.host_id:
            await interaction.response.send_message("募集主のみが終了できます。", ephemeral=True)
            return

        # VC削除
        if data.vc_id:
            vc_channel = interaction.guild.get_channel(data.vc_id)
            if vc_channel:
                try:
                    await vc_channel.delete()
                except:
                    pass
        
        # メッセージ削除
        try:
            await interaction.message.delete()
        except:
            pass
        
        # データ削除
        del recruitments[self.message_id]
        await interaction.response.send_message("募集を終了し、削除しました。", ephemeral=True)

# ---------------------------------------------------------
# メッセージ更新関数
# ---------------------------------------------------------
async def update_recruitment_message(interaction: discord.Interaction, message_id):
    # ボタン操作への応答としてメッセージを更新するため、deferが必要な場合がある
    if not interaction.response.is_done():
        await interaction.response.defer()

    data = recruitments.get(message_id)
    if not data:
        return

    # Embedの作り直し
    embed = discord.Embed(title=f"募集: {data.title}", color=discord.Color.blue())
    embed.add_field(name="開催日時", value=f"{data.date} {data.time}", inline=False)
    embed.add_field(name="募集主", value=f"<@{data.host_id}>", inline=False)
    
    # 参加者リストの生成
    for role in ["Tank", "Healer", "DPS"]:
        members = data.current_roles[role]
        member_str = "\n".join([f"<@{uid}>" for uid in members]) if members else "なし"
        embed.add_field(name=f"{role} ({len(members)}/{data.max_roles[role]})", value=member_str, inline=True)

    if data.vc_id:
        embed.add_field(name="VC", value=f"<#{data.vc_id}>", inline=False)

    # Viewの再構築（ボタンのラベル更新のため）
    new_view = ui.View(timeout=None)
    
    # 各ロールボタン
    for role in ["Tank", "Healer", "DPS"]:
        btn = RoleButton(role, message_id)
        btn.refresh_label()
        new_view.add_item(btn)
    
    new_view.add_item(LeaveButton(message_id))
    new_view.add_item(CloseButton(message_id))

    try:
        msg = await interaction.channel.fetch_message(message_id)
        await msg.edit(embed=embed, view=new_view)
    except discord.NotFound:
        pass

# ---------------------------------------------------------
# UIコンポーネント: 入力フォーム (Modal)
# ---------------------------------------------------------
class RecruitModal(ui.Modal, title='募集内容の設定'):
    def __init__(self, use_vc=False):
        super().__init__()
        self.use_vc = use_vc
        # TextInputの定義をここで行う
        self.title_input = ui.TextInput(label='タイトル', placeholder='エデン零式 1層練習', max_length=50)
        self.datetime_input = ui.TextInput(label='開催日時 (例: 1201 21:00)', placeholder='20231201 21:00', min_length=5, max_length=20)
        self.tank_input = ui.TextInput(label='Tank募集人数', placeholder='2', min_length=1, max_length=2, default='2')
        self.healer_input = ui.TextInput(label='Healer募集人数', placeholder='2', min_length=1, max_length=2, default='2')
        self.dps_input = ui.TextInput(label='DPS募集人数', placeholder='4', min_length=1, max_length=2, default='4')

        self.add_item(self.title_input)
        self.add_item(self.datetime_input)
        self.add_item(self.tank_input)
        self.add_item(self.healer_input)
        self.add_item(self.dps_input)

    async def on_submit(self, interaction: discord.Interaction):
        # 入力値の取得
        title = self.title_input.value
        datetime_val = self.datetime_input.value
        
        # 日時を分割（簡易的）
        parts = datetime_val.split()
        if len(parts) >= 2:
            date_val = parts[0]
            time_val = parts[1]
        else:
            date_val = datetime_val
            time_val = ""

        # ロール人数のパース
        try:
            t = int(self.tank_input.value)
            h = int(self.healer_input.value)
            d = int(self.dps_input.value)
            max_roles = {'Tank': t, 'Healer': h, 'DPS': d}
        except ValueError:
            await interaction.response.send_message("人数の形式が正しくありません。半角数字で入力してください。", ephemeral=True)
            return

        # ターゲットチャンネルの取得
        target_channel_id = TARGET_CHANNEL_ID
        if not target_channel_id:
            target_channel = interaction.channel
        else:
            target_channel = interaction.guild.get_channel(int(target_channel_id))
            if not target_channel:
                await interaction.response.send_message("募集チャンネルが見つかりません。", ephemeral=True)
                return

        # VC作成
        vc_id = None
        if self.use_vc:
            guild = interaction.guild
            vc_name = f"🔑_{title}_VC" 
            try:
                vc = await guild.create_voice_channel(name=vc_name)
                vc_id = vc.id
            except Exception as e:
                await interaction.response.send_message(f"VC作成に失敗しました: {e}", ephemeral=True)
                return

        # 仮メッセージ送信（ID確保のため）
        embed = discord.Embed(title="募集中...", description="準備中")
        msg = await target_channel.send(embed=embed)

        # データ保存
        data = RecruitmentData(
            host_id=interaction.user.id,
            title=title,
            date=date_val,
            time=time_val,
            max_roles=max_roles,
            vc_id=vc_id
        )
        recruitments[msg.id] = data

        # Viewを作成してメッセージ更新
        view = ui.View(timeout=None)
        
        for role in ["Tank", "Healer", "DPS"]:
            btn = RoleButton(role, msg.id)
            btn.refresh_label()
            view.add_item(btn)
        
        view.add_item(LeaveButton(msg.id))
        view.add_item(CloseButton(msg.id))

        # 初回のEmbed更新
        await update_recruitment_message(interaction, msg.id)
        
        # Modalへの応答
        if not interaction.response.is_done():
            await interaction.response.send_message(f"募集を作成しました！ -> {msg.jump_url}", ephemeral=True)
        else:
            await interaction.followup.send(f"募集を作成しました！ -> {msg.jump_url}", ephemeral=True)

# ---------------------------------------------------------
# UIコンポーネント: 募集作成トリガー (常設ボタン)
# ---------------------------------------------------------
class RecruitTriggerView(ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @ui.button(label="募集を作成", style=discord.ButtonStyle.primary, custom_id="trigger_create_recruit_no_vc")
    async def create_recruit_no_vc(self, interaction: discord.Interaction, button: ui.Button):
        await interaction.response.send_modal(RecruitModal(use_vc=False))

    @ui.button(label="募集を作成 (+VC)", style=discord.ButtonStyle.secondary, custom_id="trigger_create_recruit_with_vc")
    async def create_recruit_with_vc(self, interaction: discord.Interaction, button: ui.Button):
        await interaction.response.send_modal(RecruitModal(use_vc=True))

# ---------------------------------------------------------
# コマンド
# ---------------------------------------------------------
@bot.event
async def on_ready():
    print(f'Logged in as {bot.user} (ID: {bot.user.id})')
    print('------')

@bot.command()
async def setup(ctx):
    """
    募集作成ボタンを設置するコマンド
    """
    embed = discord.Embed(
        title="パーティー募集",
        description="下のボタンを押して募集を開始してください。",
        color=discord.Color.gold()
    )
    await ctx.send(embed=embed, view=RecruitTriggerView())

bot.run(TOKEN)
