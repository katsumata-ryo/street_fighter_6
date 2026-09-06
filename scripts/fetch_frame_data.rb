#!/usr/bin/env ruby
# frozen_string_literal: true

# STREET FIGHTER 6 公式サイトから全キャラのフレームデータを取得し JSON 化する。
#
#     ruby scripts/fetch_frame_data.rb [出力先ディレクトリ]   # 既定: data/frames
#
# - 公式サイトは User-Agent を見て bot を弾くので、ブラウザ相当の UA を付ける。
# - ページは SSR 済みなので、表のセルを class 名（frame_*）を手掛かりにパースする。
# - 数値は文字列のまま保存する（"全体 49" / "着地後3" / "D" など非数値が混ざるため）。

require 'net/http'
require 'uri'
require 'json'
require 'cgi'
require 'date'
require 'fileutils'

module SF6
  module FrameData
    UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' \
         '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    BASE = 'https://www.streetfighter.com/6/ja-jp/character/%s/frame'

    CHARACTERS = %w[
      ryu luke jamie chunli guile kimberly juri ken blanka dhalsim ehonda
      deejay manon marisa jp zangief lily cammy rashid aki ed gouki_akuma
      vega_mbison terry mai elena sagat cviper alex yasmine ingrid
    ].freeze

    # コマンド表記の画像をテキストに置き換えるための対応表。
    ICONS = {
      'key-u' => '↑', 'key-d' => '↓', 'key-l' => '←', 'key-r' => '→',
      'key-ul' => '↖', 'key-ur' => '↗', 'key-dl' => '↙', 'key-dr' => '↘',
      'key-uc' => '[↑]', 'key-dc' => '[↓]', 'key-lc' => '[←]', 'key-rc' => '[→]',
      'key-nutral' => 'N', 'key-plus' => '+', 'key-or' => 'or', 'key-circle' => '○(1回転)',
      'key-all' => '全ボタン', 'arrow_3' => '≫', 'modern_m' => '中',
      'icon_punch' => 'P', 'icon_punch_l' => '弱P', 'icon_punch_m' => '中P', 'icon_punch_h' => '強P',
      'icon_kick' => 'K', 'icon_kick_l' => '弱K', 'icon_kick_m' => '中K', 'icon_kick_h' => '強K'
    }.freeze

    # 表の 15 列のうち、技名と備考を除く 13 列。値はセルの class 名の接頭辞。
    COLUMNS = {
      'startup' => 'frame_startup_frame__',
      'active' => 'frame_active_frame__',
      'recovery' => 'frame_recovery_frame__',
      'onHit' => 'frame_hit_frame__',
      'onBlock' => 'frame_block_frame__',
      'cancel' => 'frame_cancel__',
      'damage' => 'frame_damage__',
      'scaling' => 'frame_combo_correct__',
      'driveGainHit' => 'frame_drive_gauge_gain_hit__',
      'driveLossBlock' => 'frame_drive_gauge_lose_dguard__',
      'driveLossPunish' => 'frame_drive_gauge_lose_punish__',
      'saGain' => 'frame_sa_gauge_gain__',
      'attribute' => 'frame_attribute__'
    }.freeze

    # セル内のツールチップ。持続の内訳など、ラベルとは別の情報が入っている。
    EX_RE = %r{<div class="frame_ex__.*?</div></div>}m
    # ブロック要素の境目に立てる目印。本文には出てこない文字を使う。
    SEP = "␟"

    module_function

    def unknown_icons = (@unknown_icons ||= [])

    def fetch(slug)
      uri = URI(format(BASE, slug))
      res = Net::HTTP.get_response(uri, 'User-Agent' => UA, 'Accept-Language' => 'ja')
      raise "#{slug}: HTTP #{res.code}" unless res.is_a?(Net::HTTPSuccess)

      res.body.force_encoding('UTF-8')
    end

    # HTML 断片を平文にする。<li>/<p>/<br> などはセパレータ扱い。
    def text_of(frag, sep: "\n")
      return nil if frag.nil?

      s = frag.gsub(%r{<img[^>]*?src="[^"]*/controller/([a-z0-9_-]+)\.png"[^>]*>}) do
        key = Regexp.last_match(1)
        unknown_icons << key unless ICONS.key?(key)
        ICONS.fetch(key, "[#{key}]")
      end
      s = s.gsub(/<img[^>]*>/, '')
           .gsub(%r{<br\s*/?>}, "\n")
           .gsub(%r{</(li|p|div|ul|span)>}, SEP)
           .gsub(/<[^>]+>/, '')
      s = CGI.unescapeHTML(s)
      # ボタン画像の直後に強度の文字が重複して入るので畳む（弱P弱 → 弱P）
      s = s.gsub(/(弱|中|強)([PK])\1/, '\1\2')
      s.split(SEP).map { |part| part.gsub(/[ \t　]+/, ' ').strip }.reject(&:empty?).join(sep)
    end

    # セルからツールチップを切り離す。戻り値は [本体, ツールチップ]。
    def split_ex(frag)
      [frag.gsub(EX_RE, ''), frag[EX_RE]]
    end

    def cell(cells, class_prefix)
      _, frag = cells.find { |cls, _| cls.include?(class_prefix) }
      frag
    end

    def blank?(value) = value.nil? || value.empty? || value == '　'

    def parse(doc, slug)
      name_ja = doc[%r{<title[^>]*>(.*?)</title>}m, 1].to_s.split(' ').first.to_s.strip
      health = doc[%r{frame_attention__[^"]*">体力<span>(\d+)</span>}, 1]&.to_i

      tbody = doc[doc.index('<tbody')...doc.index('</tbody>')]
      category = nil
      moves = tbody.scan(%r{<tr[^>]*>.*?</tr>}m).filter_map do |row|
        # 見出し行はカテゴリの区切り。以降の技にこのカテゴリを持たせる。
        if row.include?('frame_heading')
          heading = text_of(row)
          category = heading unless blank?(heading)
          next
        end

        cells = row.scan(%r{<t[dh]([^>]*)>(.*?)</t[dh]>}m)
                   .map { |attrs, frag| [attrs[/class="([^"]*)"/, 1].to_s, frag] }
        skill = cell(cells, 'frame_skill__')
        next if skill.nil?

        name = text_of(skill[%r{frame_arts__[^"]*">(.*?)</span>}m, 1] || skill)
        alt = nil
        # 末尾の括弧だけを別名として切り出す（「（失敗版）○○（2段目）」→ 別名は「2段目」）
        if (m = name.match(/\A(?=.)(.*)（([^（）]+)）\z/))
          name = m[1].strip
          alt = m[2].strip
        end
        command = text_of(skill[%r{frame_classic__[^"]*">(.*?)</p>}m, 1], sep: ' ')
        command = command&.gsub(/\s+/, ' ')&.strip
        command = nil if blank?(command)

        move = { 'category' => category, 'name' => name, 'nameAlt' => alt, 'command' => command }
        COLUMNS.each do |key, prefix|
          frag = cell(cells, prefix)
          if frag.nil?
            move[key] = nil
            next
          end
          body, ex = split_ex(frag)
          value = text_of(body, sep: ' ')
          move[key] = blank?(value) ? nil : value
          next unless key == 'active'

          detail = text_of(ex, sep: ' ')
          move['activeDetail'] = (blank?(detail) || detail == move[key]) ? nil : detail
        end
        move['notes'] = text_of(cell(cells, 'frame_note__')).to_s.split("\n").reject(&:empty?)
        move
      end

      {
        'character' => slug,
        'characterNameJa' => name_ja,
        'source' => format(BASE, slug),
        'fetchedAt' => Date.today.to_s,
        'health' => health,
        'moves' => moves
      }
    end

    def write_json(path, data)
      File.write(path, "#{JSON.pretty_generate(data)}\n")
    end

    def main(argv)
      outdir = argv.first || 'data/frames'
      FileUtils.mkdir_p(outdir)
      index = CHARACTERS.sort.map do |slug|
        data = parse(fetch(slug), slug)
        write_json(File.join(outdir, "#{slug}.json"), data)
        puts format('%-14s %-10s HP=%s moves=%d',
                    slug, data['characterNameJa'], data['health'], data['moves'].size)
        sleep 0.5
        { 'character' => slug, 'characterNameJa' => data['characterNameJa'],
          'health' => data['health'], 'moveCount' => data['moves'].size,
          'file' => "#{slug}.json" }
      end
      write_json(File.join(outdir, 'index.json'),
                 { 'game' => 'STREET FIGHTER 6', 'language' => 'ja-jp',
                   'fetchedAt' => Date.today.to_s, 'characters' => index })
      return if unknown_icons.empty?

      warn "未知のコマンドアイコン（ICONS に追記が必要）: #{unknown_icons.uniq.join(', ')}"
    end
  end
end

SF6::FrameData.main(ARGV) if $PROGRAM_NAME == __FILE__
