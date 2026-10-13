"""ANARCHY Discord bridge starter.

This standalone Python bot performs guild/member role sync into the PHP API.
It intentionally does not claim parity with every Discord interaction from the old
Node.js process; those actions must be ported and tested before retiring the old bot.
"""
import os, asyncio, logging
import discord
from discord.ext import commands, tasks
import requests
from dotenv import load_dotenv
load_dotenv()
logging.basicConfig(level=logging.INFO)
TOKEN=os.getenv('DISCORD_TOKEN','').strip()
GUILD_ID=int(os.getenv('DISCORD_GUILD_ID','0') or 0)
API=(os.getenv('ANARCHY_API_URL','').rstrip('/'))
SECRET=os.getenv('BOT_API_SECRET','')
intents=discord.Intents.default(); intents.members=True; intents.presences=True
bot=commands.Bot(command_prefix='!', intents=intents)

def api_post(path, payload):
    if not API or not SECRET: return
    try:
        r=requests.post(API+path,json=payload,headers={'X-ANARCHY-BOT-SECRET':SECRET},timeout=12)
        r.raise_for_status()
    except Exception as e: logging.warning('API sync failed: %s',e)

def member_payload(member):
    return {'userId':str(member.id),'username':member.name,'globalName':member.global_name or member.display_name,
            'avatar':str(member.display_avatar.url) if member.display_avatar else None,
            'roleIds':[str(role.id) for role in member.roles if role.id != member.guild.id], 'inGuild':not member.bot}

async def sync_member(member):
    api_post('/api/internal/bot/member-sync',member_payload(member))

@bot.event
async def on_ready():
    logging.info('ANARCHY Python bot online as %s',bot.user)
    guild=bot.get_guild(GUILD_ID) if GUILD_ID else None
    if guild:
        try:
            async for member in guild.fetch_members(limit=None): await sync_member(member)
            roles=[{'id':str(r.id),'name':r.name,'position':r.position,'color':f'#{r.color.value:06x}'} for r in sorted(guild.roles,key=lambda x:x.position,reverse=True) if r.id != guild.id]
            channels=[{'id':str(c.id),'name':c.name,'type':'text'} for c in guild.channels if hasattr(c,'send') and not isinstance(c,discord.CategoryChannel)]
            api_post('/api/internal/bot/status',{'online':True,'guildId':str(guild.id),'botUserId':str(bot.user.id),'roles':roles,'channels':channels})
            logging.info('Initial member sync complete: %s',guild.name)
        except Exception: logging.exception('Initial sync failed')

@bot.event
async def on_member_join(member):
    if not GUILD_ID or member.guild.id==GUILD_ID: await sync_member(member)

@bot.event
async def on_member_remove(member):
    if not GUILD_ID or member.guild.id==GUILD_ID:
        payload=member_payload(member); payload['inGuild']=False; api_post('/api/internal/bot/member-sync',payload)

@bot.event
async def on_member_update(before, after):
    if not GUILD_ID or after.guild.id==GUILD_ID: await sync_member(after)

@bot.command(name='anarchy-ping')
async def anarchy_ping(ctx):
    await ctx.reply('ANARCHY bot is online.', mention_author=False)

if __name__=='__main__':
    if not TOKEN: raise SystemExit('DISCORD_TOKEN is missing. Copy .env.example to .env and configure it.')
    bot.run(TOKEN)
