// 内置轻量 Markdown 渲染器（不依赖 CDN）
    window.marked = { parse: function(text, opts) {
      // 先 escape HTML
      var e = function(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
      var lines = text.split('\n'), out = [], inCode = false, codeLang = '', codeLines = [];
      var inTable = false, tableRows = [];

      function processInline(s) {
        return s
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.+?)\*/g, '<em>$1</em>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      }

      function flushTable() {
        if (!tableRows.length) return;
        var h = '<table>';
        tableRows.forEach(function(row, i) {
          var cells = row.split('|').map(function(c){return c.trim();}).filter(Boolean);
          if (i === 1 && cells.every(function(c){return /^[-:]+$/.test(c);})) return; // separator
          var tag = i === 0 ? 'th' : 'td';
          h += '<tr>' + cells.map(function(c){return '<'+tag+'>'+processInline(e(c))+'</'+tag+'>';}).join('') + '</tr>';
        });
        h += '</table>';
        out.push(h);
        tableRows = [];
        inTable = false;
      }

      for (var i = 0; i < lines.length; i++) {
        var L = lines[i];

        // Code blocks
        if (/^```/.test(L)) {
          if (inCode) {
            out.push('<pre><code>' + e(codeLines.join('\n')) + '</code></pre>');
            codeLines = []; inCode = false;
          } else {
            if (inTable) flushTable();
            codeLang = L.slice(3).trim(); inCode = true;
          }
          continue;
        }
        if (inCode) { codeLines.push(L); continue; }

        // Table
        if (/^\|/.test(L)) {
          if (!inTable) inTable = true;
          tableRows.push(L);
          continue;
        } else if (inTable) { flushTable(); }

        // Headers
        if (/^### /.test(L)) { out.push('<h3>' + processInline(e(L.slice(4))) + '</h3>'); continue; }
        if (/^## /.test(L))  { out.push('<h2>' + processInline(e(L.slice(3))) + '</h2>'); continue; }
        if (/^# /.test(L))   { out.push('<h1>' + processInline(e(L.slice(2))) + '</h1>'); continue; }

        // HR
        if (/^---+$/.test(L.trim())) { out.push('<hr>'); continue; }

        // Blockquote
        if (/^> /.test(L)) { out.push('<blockquote>' + processInline(e(L.slice(2))) + '</blockquote>'); continue; }

        // Unordered list
        if (/^[-*] /.test(L)) { out.push('<li>' + processInline(e(L.slice(2))) + '</li>'); continue; }
        // Ordered list
        if (/^\d+\. /.test(L)) { out.push('<li>' + processInline(e(L.replace(/^\d+\.\s*/, ''))) + '</li>'); continue; }

        // Empty line = paragraph break
        if (L.trim() === '') { out.push('<br>'); continue; }

        // Normal text
        out.push('<p>' + processInline(e(L)) + '</p>');
      }

      if (inCode) out.push('<pre><code>' + e(codeLines.join('\n')) + '</code></pre>');
      if (inTable) flushTable();

      // 合并连续的 <li> 为 <ul>
      return out.join('\n')
        .replace(/(<li>[\s\S]*?<\/li>)(\n<li>)/g, '$1$2')
        .replace(/(<li>[\s\S]*?<\/li>)/g, function(m) {
          return '<ul>' + m + '</ul>';
        })
        .replace(/<\/ul>\n?<ul>/g, '');
    }};

const API_URL = window.location.origin + '/api';
    
    const originalFetch = window.fetch;
    window.fetch = (url, options = {}) => {
      return originalFetch(url, { ...options, headers: { ...options.headers, 'ngrok-skip-browser-warning': 'true' }});
    };

    let currentSpace = null;
    let currentSession = null;
    let currentTab = 'chat';

    // ==================== Space List ====================
    
    async function loadSpaces() {
      try {
        const res = await fetch(`${API_URL}/spaces`);
        const { spaces } = await res.json();
        
        const grid = document.getElementById('spaces-grid');
        if (!spaces || spaces.length === 0) {
          grid.innerHTML = `<div class="col-span-3 text-center text-gray-500 py-12">
            <p class="mb-4">No spaces yet</p>
            <button onclick="createSpace()" class="text-blue-600 hover:underline">Create your first space</button>
          </div>`;
        } else {
          grid.innerHTML = spaces.map(s => `
            <div class="space-card rounded-xl p-6 cursor-pointer" onclick="enterSpace('${s.space_id}')">
              <div class="flex items-center space-x-3 mb-4">
                <div class="icon-gradient p-3 rounded-lg">
                  <svg class="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                  </svg>
                </div>
                <div>
                  <h3 class="text-lg font-bold text-gray-900">${escapeHtml(s.name)}</h3>
                  <p class="text-sm text-gray-500">${escapeHtml(s.description || '')}</p>
                </div>
              </div>
              <div class="flex items-center justify-between text-sm">
                <div class="flex space-x-4">
                  <span class="text-green-600">${s.agent_count || 0} agents</span>
                  <span class="text-purple-600">${s.skill_count || 0} skills</span>
                </div>
                <span class="text-gray-400">${formatTime(s.last_activity)}</span>
              </div>
            </div>
          `).join('');
        }
      } catch (err) { console.error('Failed to load spaces:', err); }
    }

    // ==================== Create Space Wizard ====================

    const SKILL_PACKS = [
      // Add your own curated skill packs here
      // { tag: 'my-org', name: '🏢 My Org Skills', desc: 'Organization skill pack', icon: '🏢', defaultSelected: true },
      { tag: 'dev-tools', name: '🛠️ 开发工具', desc: '代码审查、调试、系统设计模板', icon: '🛠️' },
      { tag: 'product-design', name: '📊 产品设计', desc: '需求分析、竞品分析、用户研究', icon: '📊' },
      { tag: 'research', name: '🔬 技术研究', desc: 'API 调研、架构分析、技术选型', icon: '🔬' },
      { tag: 'data-analysis', name: '📈 数据分析', desc: '日志分析、数据可视化、指标监控', icon: '📈' },
      { tag: 'writing', name: '✍️ 文档写作', desc: '技术文档、PRD、方案设计', icon: '✍️' },
      { tag: 'devops', name: '🚀 DevOps', desc: '部署、CI/CD、监控告警', icon: '🚀' },
    ];
    const MAX_AGENTS = 5;

    let wizardStep = 1;
    let wizardAgents = []; // { agent_id, name, capabilities, description, selected }
    let wizardSelectedPacks = new Set();
    let wizardImportSkills = []; // { skill_id, source_space_id, name, description, tags, selected }
    let wizardSearchSkills = []; // same shape
    let wizardSkillSearchTimer = null;

    function createSpace() {
      wizardStep = 1;
      wizardAgents = [];
      wizardSelectedPacks = new Set(SKILL_PACKS.filter(p => p.defaultSelected).map(p => p.tag));
      wizardImportSkills = [];
      wizardSearchSkills = [];
      document.getElementById('wizard-space-name').value = '';
      document.getElementById('wizard-space-desc').value = '';
      document.getElementById('create-space-modal').classList.remove('hidden');
      wizardRenderStep();
    }

    function closeCreateSpaceWizard() {
      document.getElementById('create-space-modal').classList.add('hidden');
    }

    function wizardRenderStep() {
      const subtitles = { 1: '基本信息', 2: '选择 Agent', 3: '配置 Skill' };
      document.getElementById('wizard-subtitle').textContent = subtitles[wizardStep];

      // Steps visibility
      for (let i = 1; i <= 3; i++) {
        const el = document.getElementById(`wizard-step-${i}`);
        if (i === wizardStep) {
          el.classList.remove('hidden');
          el.style.opacity = '0';
          el.style.transform = 'translateX(10px)';
          requestAnimationFrame(() => {
            el.style.opacity = '1';
            el.style.transform = 'translateX(0)';
          });
        } else {
          el.classList.add('hidden');
        }
      }

      // Step dots
      for (let i = 1; i <= 3; i++) {
        const dot = document.getElementById(`step-dot-${i}`);
        const label = document.getElementById(`step-label-${i}`);
        if (i < wizardStep) {
          dot.className = 'w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center text-sm font-bold transition-all duration-300';
          dot.textContent = '✓';
          label.className = 'flex-1 text-center text-green-600 font-medium';
        } else if (i === wizardStep) {
          dot.className = 'w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-bold transition-all duration-300';
          dot.textContent = i;
          label.className = 'flex-1 text-center text-blue-600 font-medium';
        } else {
          dot.className = 'w-8 h-8 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-sm font-bold transition-all duration-300';
          dot.textContent = i;
          label.className = 'flex-1 text-center text-gray-400';
        }
      }

      // Step lines
      for (let i = 1; i <= 2; i++) {
        const line = document.getElementById(`step-line-${i}`);
        line.className = i < wizardStep
          ? 'flex-1 h-0.5 bg-green-500 mx-2 transition-all duration-300'
          : 'flex-1 h-0.5 bg-gray-200 mx-2 transition-all duration-300';
      }

      // Buttons
      document.getElementById('wizard-btn-prev').classList.toggle('hidden', wizardStep === 1);
      document.getElementById('wizard-btn-next').classList.toggle('hidden', wizardStep === 3);
      document.getElementById('wizard-btn-create').classList.toggle('hidden', wizardStep !== 3);

      // Summary
      const agentCount = wizardAgents.filter(a => a.selected).length;
      const skillCount = wizardSelectedPacks.size + wizardImportSkills.filter(s => s.selected).length + wizardSearchSkills.filter(s => s.selected).length;
      document.getElementById('wizard-summary').textContent = `步骤 ${wizardStep}/3 · ${agentCount} Agents, ${skillCount} Skills`;

      // Load data for step
      if (wizardStep === 2 && wizardAgents.length === 0) wizardLoadAgents();
      if (wizardStep === 3) wizardRenderPacks();
    }

    async function wizardLoadAgents() {
      try {
        const res = await fetch(`${API_URL}/agents`);
        const { agents } = await res.json();
        wizardAgents = agents.map((a, i) => ({ ...a, selected: i < 3 }));
        wizardRenderAgents();
      } catch (err) {
        document.getElementById('wizard-agents-list').innerHTML = '<div class="text-center py-8 text-red-500 text-sm">加载失败</div>';
      }
    }

    function wizardRenderAgents() {
      const container = document.getElementById('wizard-agents-list');
      if (wizardAgents.length === 0) {
        container.innerHTML = '<div class="text-center py-8 text-gray-400 text-sm">暂无可用 Agent</div>';
        return;
      }
      const selectedCount = wizardAgents.filter(a => a.selected).length;
      const atMax = selectedCount >= MAX_AGENTS;
      container.innerHTML = wizardAgents.map((a, idx) => {
        const disabled = !a.selected && atMax;
        return `
        <label class="flex items-center p-3 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50/50 cursor-pointer transition-all card-hover ${disabled ? 'opacity-50 cursor-not-allowed' : ''}">
          <input type="checkbox" ${a.selected ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="wizardToggleAgent(${idx}, this.checked)" class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 mr-3 flex-shrink-0" />
          <div class="flex-1 min-w-0">
            <div class="flex items-center space-x-2">
              <span class="text-sm font-medium text-gray-900 truncate">${escapeHtml(a.name)}</span>
              ${a.description ? `<span class="text-xs text-gray-400 truncate hidden sm:inline">${escapeHtml(a.description)}</span>` : ''}
            </div>
            ${a.capabilities?.length ? `<div class="flex flex-wrap gap-1 mt-1">${a.capabilities.map(c => `<span class="inline-block px-1.5 py-0.5 text-xs rounded bg-blue-100 text-blue-700">${escapeHtml(c)}</span>`).join('')}</div>` : ''}
          </div>
        </label>
      `}).join('') + (atMax ? '<div class="text-xs text-orange-500 text-center py-1">最多选择 ' + MAX_AGENTS + ' 个 Agent</div>' : '');
    }

    function wizardToggleAgent(idx, checked) {
      const selectedCount = wizardAgents.filter(a => a.selected).length;
      if (checked && selectedCount >= MAX_AGENTS) {
        // Re-render to restore checkbox state
        wizardRenderAgents();
        return;
      }
      wizardAgents[idx].selected = checked;
      wizardRenderAgents();
      wizardUpdateSummary();
    }

    function wizardToggleAllAgents(selectAll) {
      if (selectAll) {
        // Select up to MAX_AGENTS
        let count = 0;
        wizardAgents.forEach(a => { a.selected = count < MAX_AGENTS; if (a.selected) count++; });
      } else {
        wizardAgents.forEach(a => a.selected = false);
      }
      wizardRenderAgents();
      wizardUpdateSummary();
    }

    function wizardUpdateSummary() {
      const agentCount = wizardAgents.filter(a => a.selected).length;
      const skillCount = wizardSelectedPacks.size + wizardImportSkills.filter(s => s.selected).length + wizardSearchSkills.filter(s => s.selected).length;
      document.getElementById('wizard-summary').textContent = `步骤 ${wizardStep}/3 · ${agentCount} Agents, ${skillCount} Skills`;
    }

    // Step 3: Skill Packs
    async function wizardRenderPacks() {
      const grid = document.getElementById('wizard-packs-grid');
      // Fetch skill counts for each pack in parallel
      const packData = await Promise.all(SKILL_PACKS.map(async p => {
        try {
          const res = await fetch(`${API_URL}/skill-packs/${p.tag}/skills`);
          const data = await res.json();
          return { ...p, skillCount: data.skills?.length || 0 };
        } catch { return { ...p, skillCount: 0 }; }
      }));

      grid.innerHTML = packData.map(p => {
        const sel = wizardSelectedPacks.has(p.tag);
        return `
          <div onclick="wizardTogglePack('${p.tag}')" class="p-4 rounded-xl border-2 cursor-pointer transition-all duration-200 ${sel ? 'border-blue-500 bg-blue-50/80 shadow-md' : 'border-gray-200 hover:border-gray-300 bg-white'}" id="pack-card-${p.tag}">
            <div class="flex items-center justify-between mb-2">
              <span class="text-2xl">${p.icon}</span>
              ${sel ? '<svg class="w-5 h-5 text-blue-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>' : '<div class="w-5 h-5 rounded-full border-2 border-gray-300"></div>'}
            </div>
            <h4 class="text-sm font-bold text-gray-900">${escapeHtml(p.name.replace(/^.+\s/, ''))}</h4>
            <p class="text-xs text-gray-500 mt-0.5">${escapeHtml(p.desc)}</p>
            <p class="text-xs mt-2 ${p.skillCount > 0 ? 'text-green-600' : 'text-gray-400'}">${p.skillCount > 0 ? `${p.skillCount} 个 Skill` : '空包，创建后可添加'}</p>
          </div>
        `;
      }).join('');

      // Also load spaces for import tab
      wizardLoadSpacesForImport();
    }

    function wizardTogglePack(tag) {
      if (wizardSelectedPacks.has(tag)) {
        wizardSelectedPacks.delete(tag);
      } else {
        wizardSelectedPacks.add(tag);
      }
      wizardRenderPacks();
      wizardUpdateSummary();
    }

    // Skill Tab switching
    function wizardSkillTab(tab) {
      ['packs', 'import', 'search'].forEach(t => {
        document.getElementById(`skill-tab-${t}`).className = t === tab
          ? 'flex-1 text-xs font-medium px-3 py-1.5 rounded-md bg-white text-blue-600 shadow-sm transition-all'
          : 'flex-1 text-xs font-medium px-3 py-1.5 rounded-md text-gray-500 hover:text-gray-700 transition-all';
        document.getElementById(`skill-content-${t}`).classList.toggle('hidden', t !== tab);
      });
    }

    // Import from Space
    async function wizardLoadSpacesForImport() {
      try {
        const res = await fetch(`${API_URL}/spaces`);
        const { spaces } = await res.json();
        const select = document.getElementById('wizard-import-space');
        // Keep the first option
        select.innerHTML = '<option value="">选择一个 Space…</option>' +
          spaces.map(s => `<option value="${s.space_id}">${escapeHtml(s.name)}</option>`).join('');
      } catch (err) { console.error('Failed to load spaces for import:', err); }
    }

    async function wizardLoadSpaceSkills(spaceId) {
      const container = document.getElementById('wizard-import-skills');
      const actions = document.getElementById('wizard-import-actions');
      if (!spaceId) {
        container.innerHTML = '<p class="text-center py-6 text-gray-400 text-sm">选择 Space 后加载 Skills</p>';
        actions.classList.add('hidden');
        wizardImportSkills = [];
        wizardUpdateSummary();
        return;
      }
      container.innerHTML = '<div class="text-center py-6 text-gray-400 text-sm">加载中...</div>';
      try {
        const res = await fetch(`${API_URL}/spaces/${spaceId}/skills`);
        const { skills } = await res.json();
        wizardImportSkills = skills.map(s => ({
          skill_id: s.skill_id,
          source_space_id: spaceId,
          name: s.name,
          description: s.description || '',
          tags: s.metadata?.tags || s.tags || [],
          selected: true
        }));
        if (wizardImportSkills.length === 0) {
          container.innerHTML = '<p class="text-center py-6 text-gray-400 text-sm">该 Space 暂无 Skill</p>';
          actions.classList.add('hidden');
        } else {
          actions.classList.remove('hidden');
          wizardRenderImportSkills();
        }
        wizardUpdateSummary();
      } catch (err) {
        container.innerHTML = '<p class="text-center py-6 text-red-500 text-sm">加载失败</p>';
      }
    }

    function wizardRenderImportSkills() {
      const container = document.getElementById('wizard-import-skills');
      container.innerHTML = wizardImportSkills.map((s, idx) => `
        <label class="flex items-center p-3 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50/50 cursor-pointer transition-all card-hover">
          <input type="checkbox" ${s.selected ? 'checked' : ''} onchange="wizardImportSkills[${idx}].selected = this.checked; wizardUpdateSummary()" class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 mr-3 flex-shrink-0" />
          <div class="flex-1 min-w-0">
            <span class="text-sm font-medium text-gray-900">${escapeHtml(s.name)}</span>
            ${s.description ? `<p class="text-xs text-gray-500 mt-0.5 truncate">${escapeHtml(s.description)}</p>` : ''}
            ${s.tags?.length ? `<div class="flex flex-wrap gap-1 mt-1">${s.tags.map(t => `<span class="inline-block px-1.5 py-0.5 text-xs rounded bg-purple-100 text-purple-700">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          </div>
        </label>
      `).join('');
    }

    function wizardToggleAllImportSkills(selectAll) {
      wizardImportSkills.forEach(s => s.selected = selectAll);
      wizardRenderImportSkills();
      wizardUpdateSummary();
    }

    // Search Skills
    function wizardSkillSearchDebounce() {
      clearTimeout(wizardSkillSearchTimer);
      wizardSkillSearchTimer = setTimeout(wizardSkillSearch, 300);
    }

    async function wizardSkillSearch() {
      const q = document.getElementById('wizard-skill-search-input').value.trim();
      const container = document.getElementById('wizard-search-results');
      if (!q) {
        container.innerHTML = '<p class="text-center py-6 text-gray-400 text-sm">输入关键词搜索 Skill</p>';
        wizardSearchSkills = [];
        wizardUpdateSummary();
        return;
      }
      container.innerHTML = '<div class="text-center py-6 text-gray-400 text-sm">搜索中...</div>';
      try {
        const res = await fetch(`${API_URL}/skills/search?q=${encodeURIComponent(q)}`);
        const { skills } = await res.json();
        wizardSearchSkills = skills.map(s => ({ ...s, selected: false }));
        if (wizardSearchSkills.length === 0) {
          container.innerHTML = '<p class="text-center py-6 text-gray-400 text-sm">无匹配结果</p>';
        } else {
          wizardRenderSearchSkills();
        }
        wizardUpdateSummary();
      } catch (err) {
        container.innerHTML = '<p class="text-center py-6 text-red-500 text-sm">搜索失败</p>';
      }
    }

    function wizardRenderSearchSkills() {
      const container = document.getElementById('wizard-search-results');
      container.innerHTML = wizardSearchSkills.map((s, idx) => `
        <label class="flex items-center p-3 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50/50 cursor-pointer transition-all card-hover">
          <input type="checkbox" ${s.selected ? 'checked' : ''} onchange="wizardSearchSkills[${idx}].selected = this.checked; wizardUpdateSummary()" class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 mr-3 flex-shrink-0" />
          <div class="flex-1 min-w-0">
            <span class="text-sm font-medium text-gray-900">${escapeHtml(s.name)}</span>
            ${s.description ? `<p class="text-xs text-gray-500 mt-0.5 truncate">${escapeHtml(s.description)}</p>` : ''}
            ${s.tags?.length ? `<div class="flex flex-wrap gap-1 mt-1">${s.tags.map(t => `<span class="inline-block px-1.5 py-0.5 text-xs rounded bg-purple-100 text-purple-700">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          </div>
        </label>
      `).join('');
    }

    // Navigation
    function wizardNext() {
      if (wizardStep === 1) {
        const name = document.getElementById('wizard-space-name').value.trim();
        if (!name) {
          document.getElementById('wizard-space-name').focus();
          document.getElementById('wizard-space-name').classList.add('ring-2', 'ring-red-300', 'border-red-400');
          setTimeout(() => document.getElementById('wizard-space-name').classList.remove('ring-2', 'ring-red-300', 'border-red-400'), 1500);
          return;
        }
      }
      if (wizardStep < 3) {
        wizardStep++;
        wizardRenderStep();
        // Scroll body to top
        document.getElementById('wizard-body').scrollTop = 0;
      }
    }

    function wizardPrev() {
      if (wizardStep > 1) {
        wizardStep--;
        wizardRenderStep();
        document.getElementById('wizard-body').scrollTop = 0;
      }
    }

    async function wizardCreate() {
      const name = document.getElementById('wizard-space-name').value.trim();
      if (!name) { wizardStep = 1; wizardRenderStep(); return; }
      const description = document.getElementById('wizard-space-desc').value.trim();
      const selectedAgents = wizardAgents.filter(a => a.selected).map(a => a.agent_id);
      const loadPacks = [...wizardSelectedPacks];
      const importSkills = wizardImportSkills.filter(s => s.selected);
      const searchSkills = wizardSearchSkills.filter(s => s.selected);

      // Disable create button
      const btn = document.getElementById('wizard-btn-create');
      btn.disabled = true;
      btn.textContent = '⏳ 创建中...';

      try {
        // 1. Create Space
        const res = await fetch(`${API_URL}/spaces`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, load_packs: loadPacks.length > 0 ? loadPacks : undefined })
        });
        if (!res.ok) throw new Error('Failed to create space');
        const space = await res.json();
        const spaceId = space.space_id;

        // 2. Batch register agents
        if (selectedAgents.length > 0) {
          await fetch(`${API_URL}/spaces/${spaceId}/members/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_ids: selectedAgents })
          });
        }

        // 3. Clone selected skills (import + search)
        const allSkillsToClone = [...importSkills, ...searchSkills];
        for (const skill of allSkillsToClone) {
          try {
            // Fetch full skill data from source
            const skillRes = await fetch(`${API_URL}/spaces/${skill.source_space_id}/skills/${skill.skill_id}`);
            if (!skillRes.ok) continue;
            const skillData = await skillRes.json();
            // Create in new space
            await fetch(`${API_URL}/spaces/${spaceId}/skills`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: skillData.name,
                version: skillData.version || '1.0.0',
                description: skillData.description || '',
                skill_md: skillData.skill_md || '',
                metadata: { ...(skillData.metadata || {}), cloned_from: skill.skill_id }
              })
            });
          } catch (e) { console.error('Failed to clone skill:', skill.name, e); }
        }

        closeCreateSpaceWizard();
        await loadSpaces();
      } catch (err) {
        console.error('Failed to create space:', err);
        btn.disabled = false;
        btn.textContent = '✨ 创建 Space';
      }
    }

    // ==================== URL 路由 ====================
    
    function updateUrl() {
      if (currentSpace && currentSession) {
        window.location.hash = `/space/${currentSpace}/session/${currentSession}`;
      } else if (currentSpace) {
        window.location.hash = `/space/${currentSpace}`;
      } else {
        window.location.hash = '';
      }
    }

    function parseHash() {
      const hash = window.location.hash.replace(/^#\/?/, '');
      const spaceMatch = hash.match(/^space\/([^/]+)(?:\/session\/([^/]+))?/);
      if (spaceMatch) {
        return { spaceId: spaceMatch[1], sessionId: spaceMatch[2] || null };
      }
      return { spaceId: null, sessionId: null };
    }

    async function routeFromHash() {
      const { spaceId, sessionId } = parseHash();
      if (spaceId && spaceId !== currentSpace) {
        await enterSpace(spaceId, true);  // skipUrlUpdate=true
      }
      if (spaceId && sessionId && sessionId !== currentSession) {
        await selectSession(sessionId, true);
      }
    }

    window.addEventListener('hashchange', () => routeFromHash());

    function goHome() {
      currentSpace = null;
      currentSession = null;
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      document.getElementById('view-spaces').classList.remove('hidden');
      document.getElementById('view-space-detail').classList.add('hidden');
      document.getElementById('breadcrumb').innerHTML = '';
      updateUrl();
      loadSpaces();
    }

    // ==================== Space Detail ====================

    async function enterSpace(spaceId, skipUrlUpdate) {
      currentSpace = spaceId;
      currentSession = null;
      
      // 停止旧的自动刷新
      if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
      
      document.getElementById('view-spaces').classList.add('hidden');
      document.getElementById('view-space-detail').classList.remove('hidden');
      
      // 重置聊天区域
      document.getElementById('session-title').textContent = 'Select a Session';
      document.getElementById('session-info').textContent = 'Click a session to start chatting';
      document.getElementById('session-actions').classList.add('hidden');
      document.getElementById('agent-control-bar').classList.add('hidden');
      document.getElementById('system-prompt-panel').classList.add('hidden');
      document.getElementById('messages-container').innerHTML = `
        <div class="text-center text-gray-400 py-12">
          <svg class="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
          </svg>
          <p>Select a session to start</p>
        </div>`;
      
      try {
        const res = await fetch(`${API_URL}/spaces/${spaceId}`);
        const { space } = await res.json();
        
        document.getElementById('space-name').textContent = space.name;
        document.getElementById('space-description').textContent = space.description || 'No description';
        document.getElementById('breadcrumb').innerHTML = `<span class="text-gray-400">Spaces</span> / <span class="font-medium text-gray-700">${escapeHtml(space.name)}</span>`;
        
        await loadSpaceStats();
        switchTab('chat');
        if (!skipUrlUpdate) updateUrl();
      } catch (err) { console.error('Failed to enter space:', err); }
    }

    async function loadSpaceStats() {
      if (!currentSpace) return;
      try {
        const [agentsRes, skillsRes, sessionsRes] = await Promise.all([
          fetch(`${API_URL}/spaces/${currentSpace}/agents`),
          fetch(`${API_URL}/spaces/${currentSpace}/skills`),
          fetch(`${API_URL}/spaces/${currentSpace}/sessions?status=active`)
        ]);
        const agents = await agentsRes.json();
        const skills = await skillsRes.json();
        const sessions = await sessionsRes.json();
        
        document.getElementById('agent-count').textContent = agents.agents?.length || 0;
        document.getElementById('skill-count').textContent = skills.skills?.length || 0;
        document.getElementById('session-count').textContent = sessions.sessions?.length || 0;
      } catch (err) { console.error('Failed to load stats:', err); }
    }

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach(btn => {
        const isActive = btn.dataset.tab === tab;
        btn.classList.toggle('active', isActive);
        btn.classList.toggle('border-blue-500', isActive);
        btn.classList.toggle('text-blue-600', isActive);
        btn.classList.toggle('border-transparent', !isActive);
        btn.classList.toggle('text-gray-500', !isActive);
      });
      document.getElementById('tab-chat').classList.toggle('hidden', tab !== 'chat');
      document.getElementById('tab-agents').classList.toggle('hidden', tab !== 'agents');
      document.getElementById('tab-skills').classList.toggle('hidden', tab !== 'skills');
      document.getElementById('tab-files').classList.toggle('hidden', tab !== 'files');
      
      if (tab === 'chat') loadSessions();
      if (tab === 'agents') loadAgents();
      if (tab === 'skills') loadSkills();
      if (tab === 'files') loadFiles();
    }

    // ==================== Sessions ====================

    async function loadSessions() {
      if (!currentSpace) return;
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/sessions?status=active`);
        const { sessions } = await res.json();
        
        const container = document.getElementById('sessions-list');
        if (!sessions || sessions.length === 0) {
          container.innerHTML = `<div class="px-4 py-8 text-center text-gray-500">
            <p class="mb-2">No sessions</p>
            <button onclick="createSession()" class="text-blue-600 hover:underline text-sm">Create one</button>
          </div>`;
        } else {
          container.innerHTML = sessions.map(s => `
            <div class="session-item px-4 py-3 cursor-pointer border-b border-gray-100 ${currentSession === s.session_id ? 'active' : ''}"
                 onclick="selectSession('${s.session_id}')">
              <div class="flex justify-between items-start">
                <div class="flex-1 min-w-0">
                  <h4 class="text-sm font-medium text-gray-900 truncate">${escapeHtml(s.title)}</h4>
                  <p class="text-xs text-gray-500">${s.message_count || 0} msgs</p>
                </div>
                <span class="text-xs text-gray-400">${formatTime(s.last_activity)}</span>
              </div>
            </div>
          `).join('');
        }
      } catch (err) { console.error('Failed to load sessions:', err); }
    }

    async function createSession() {
      if (!currentSpace) return;
      const title = `新对话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/sessions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, created_by: 'human' })
        });
        if (res.ok) {
          const session = await res.json();
          await loadSessions();
          await loadSpaceStats();
          selectSession(session.session_id);
        }
      } catch (err) { console.error('Failed to create session:', err); }
    }

    async function selectSession(sessionId, skipUrlUpdate) {
      currentSession = sessionId;
      document.querySelectorAll('.session-item').forEach(item => item.classList.remove('active'));
      event?.target?.closest('.session-item')?.classList.add('active');
      
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/sessions/${sessionId}`);
        const { session, message_count } = await res.json();
        
        document.getElementById('session-title').textContent = session.title;
        document.getElementById('session-info').textContent = `${message_count} messages`;
        document.getElementById('session-actions').classList.remove('hidden');
        
        await loadMessages();
        await loadSystemPrompt();
        await loadAgentControl();
        if (!skipUrlUpdate) updateUrl();
        if (autoRefreshTimer) clearInterval(autoRefreshTimer);
        refreshInterval = 1000; // Reset to normal
        restartAutoRefresh();
      } catch (err) { console.error('Failed to load session:', err); }
    }

    async function archiveSession() {
      if (!currentSession || !confirm('Archive this session?')) return;
      try {
        await fetch(`${API_URL}/spaces/${currentSpace}/sessions/${currentSession}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'closed' })
        });
        currentSession = null;
        document.getElementById('session-title').textContent = 'Select a Session';
        document.getElementById('session-info').textContent = '';
        document.getElementById('session-actions').classList.add('hidden');
        document.getElementById('messages-container').innerHTML = '<div class="text-center text-gray-400 py-12">Session archived</div>';
        await loadSessions();
        await loadSpaceStats();
      } catch (err) { console.error('Failed to archive:', err); }
    }

    // ==================== Messages ====================

    async function loadMessages() {
      if (!currentSpace || !currentSession) return;
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/sessions/${currentSession}/messages`);
        const { messages } = await res.json();
        
        document.getElementById('messages-container').innerHTML = `
          <div class="relative">
            <div id="messages-list" class="space-y-4 max-h-[400px] overflow-y-auto p-4 messages-area rounded-lg mb-4">
              ${messages.length === 0 ? '<div class="text-center text-gray-500 py-8">No messages yet</div>' : messages.map(renderMessage).join('')}
            </div>
            <!-- Summary floating button -->
            <div id="summary-widget" class="absolute bottom-2 right-2 z-10">
              <button id="summary-btn" onclick="toggleSummaryPanel()" 
                class="bg-indigo-600 hover:bg-indigo-700 text-white rounded-full w-9 h-9 flex items-center justify-center shadow-lg text-sm transition-all"
                title="Session Summary">
                📋
              </button>
              <div id="summary-panel" class="hidden absolute bottom-12 right-0 w-96 max-h-80 bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden">
                <div class="flex items-center justify-between px-4 py-2 bg-indigo-50 border-b">
                  <span class="font-semibold text-indigo-800 text-sm">Session Summary</span>
                  <div class="flex items-center gap-2">
                    <span id="summary-meta" class="text-xs text-gray-400"></span>
                    <button onclick="toggleSummaryPanel()" class="text-gray-400 hover:text-gray-600">&times;</button>
                  </div>
                </div>
                <div id="summary-content" class="p-4 overflow-y-auto max-h-64 text-sm text-gray-700 whitespace-pre-wrap">
                  <span class="text-gray-400">No summary yet. Summary is auto-generated after 10+ messages.</span>
                </div>
              </div>
            </div>
          </div>
          <div class="flex space-x-3">
            <div class="flex-1 flex items-center gap-2 border border-gray-300 rounded-lg input-inset px-3">
              <label class="cursor-pointer text-gray-400 hover:text-blue-500 shrink-0" title="附件">
                📎
                <input type="file" id="chat-file-input" class="hidden" multiple onchange="onChatFileSelect(this)">
              </label>
              <div id="chat-file-preview" class="hidden flex items-center gap-1 shrink-0"></div>
              <textarea id="human-input" placeholder="Enter your job/question... (Shift+Enter 换行)"
                class="flex-1 py-2 border-0 focus:outline-none resize-none" rows="1"
                onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}"
                oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
            </div>
            <button onclick="sendMessage()" class="btn-lift bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium">Send</button>
          </div>
        `;
        setTimeout(() => {
          const list = document.getElementById('messages-list');
          if (list) list.scrollTop = list.scrollHeight;
        }, 100);
      } catch (err) { console.error('Failed to load messages:', err); }
    }

    let refreshInterval = 1000; // ms
    let autoRefreshTimer = null;

    // 判断用户是否在底部附近（50px 容差）
    function isNearBottom(el) {
      return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    }

    async function refreshMessages() {
      if (!currentSpace || !currentSession) return;
      const list = document.getElementById('messages-list');
      if (!list) return;

      // 记录刷新前是否在底部
      const wasAtBottom = isNearBottom(list);

      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/sessions/${currentSession}/messages`);
        const { messages } = await res.json();
        
        let hasStreamingMessages = false;
        let hasNewAgentMessage = false;
        const hasChanged = (oldHash, newHash) => oldHash !== newHash;
        
        messages.forEach(msg => {
          const existing = document.querySelector(`[data-message-id="${msg.message_id}"]`);
          const newHash = hashContent(msg);

          // 🆕 如果消息更新为 NO_REPLY/NO 等，隐藏已渲染的气泡
          const _r2 = (typeof msg.content?.result === 'string' ? msg.content.result.trim() : '');
          const isNoReply = _r2 === '[NO_REPLY]' || _r2 === 'NO_REPLY' || _r2 === 'NO' || _r2 === 'HEARTBEAT_OK';
          if (isNoReply && existing) {
            existing.remove();
            return;
          }
          if (isNoReply) return; // 新消息直接跳过
          
          if (existing) {
            const oldHash = existing.dataset.contentHash;
            if (hasChanged(oldHash, newHash)) {
              const content = existing.querySelector('.message-content');
              content.innerHTML = formatMessageContent(msg);
              existing.dataset.contentHash = newHash;
              
              const streamIndicator = existing.querySelector('[data-stream-indicator]');
              const isStreaming = msg.type === 'human_job_response' && msg.content?.streaming;
              if (streamIndicator) {
                streamIndicator.textContent = isStreaming ? '⏳ streaming' : '';
                streamIndicator.classList.toggle('animate-pulse', isStreaming);
                streamIndicator.classList.toggle('hidden', !isStreaming);
              }
              
              if (isStreaming) hasStreamingMessages = true;
              // 内容更新也算 agent 活动（流式更新时跟随滚动）
              if (msg.from_agent !== 'human') hasNewAgentMessage = true;
            }
          } else {
            list.insertAdjacentHTML('beforeend', renderMessage(msg));
            const isStreaming = msg.type === 'human_job_response' && msg.content?.streaming;
            if (isStreaming) hasStreamingMessages = true;
            // 新的 agent 消息到达 → 触发滚底
            if (msg.from_agent !== 'human') hasNewAgentMessage = true;
          }
        });
        
        // 只在以下情况滚到底部：
        // 1. 有新的 agent 消息/更新 且 用户之前就在底部附近
        // 2. 或者用户本来就在底部（跟随新消息）
        if (hasNewAgentMessage && wasAtBottom) {
          list.scrollTop = list.scrollHeight;
        }
        
        // 🆕 移除 server 上已删除的消息（NO_REPLY 占位消息被删后前端同步清除）
        const serverMessageIds = new Set(messages.map(m => m.message_id));
        list.querySelectorAll('[data-message-id]').forEach(el => {
          if (!serverMessageIds.has(el.dataset.messageId)) {
            el.remove();
          }
        });
        
        if (hasStreamingMessages) {
          if (refreshInterval !== 300) { refreshInterval = 300; restartAutoRefresh(); }
        } else {
          if (refreshInterval !== 1000) { refreshInterval = 1000; restartAutoRefresh(); }
        }
      } catch (err) { console.error('Refresh failed:', err); }
      
      // 🆕 每 30 秒自动刷新 summary（如果面板打开）
      if (summaryPanelOpen && Date.now() - lastSummaryRefresh > 30000) {
        lastSummaryRefresh = Date.now();
        refreshSummary();
      }
    }

    function restartAutoRefresh() {
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      autoRefreshTimer = setInterval(refreshMessages, refreshInterval);
    }

    function renderMessage(msg) {
      const isHuman = msg.from_agent === 'human';
      const isStreaming = msg.type === 'human_job_response' && msg.content?.streaming;
      // 隐藏 NO_REPLY 消息（包括各种变体）
      const _r = (typeof msg.content?.result === 'string' ? msg.content.result.trim() : '');
      if (_r === '[NO_REPLY]' || _r === 'NO_REPLY' || _r === 'NO' || _r === 'HEARTBEAT_OK') return '';
      return `
        <div class="flex space-x-3" data-message-id="${msg.message_id}" data-content-hash="${hashContent(msg)}">
          <div class="w-8 h-8 ${isHuman ? 'bg-green-100' : 'bg-blue-100'} rounded-full flex items-center justify-center flex-shrink-0">
            <span class="text-sm">${isHuman ? '👤' : '🤖'}</span>
          </div>
          <div class="flex-1">
            <div class="flex items-center space-x-2">
              <span class="text-sm font-medium">${msg.from_name || msg.from_agent}</span>
              <span class="text-xs text-gray-400">${new Date(msg.timestamp).toLocaleTimeString()}</span>
              <span data-stream-indicator class="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded ${isStreaming ? 'animate-pulse' : 'hidden'}">${isStreaming ? '⏳ streaming' : ''}</span>
            </div>
            <div class="message-content msg-bubble mt-1 text-sm text-gray-700 ${isHuman ? 'bg-green-50' : 'bg-blue-50 msg-md'} p-3 rounded-lg inline-block max-w-[90%]">${formatMessageContent(msg)}</div>
          </div>
        </div>
      `;
    }

    function hashContent(msg) {
      // Simple hash to detect content changes
      const c = msg.content || {};
      const key = `${msg.type}:${msg.from_agent}:${JSON.stringify(c)}`;
      let hash = 0;
      for (let i = 0; i < key.length; i++) {
        hash = ((hash << 5) - hash) + key.charCodeAt(i);
        hash = hash & hash;
      }
      return hash.toString(36);
    }

    function formatMessageContent(msg) {
      const c = msg.content || {};
      let raw = '';
      if (msg.type === 'human_job') {
        raw = c.job || c.message || '';
      } else if (msg.type === 'human_job_response') {
        raw = typeof c.result === 'string' ? c.result : JSON.stringify(c.result, null, 2);
      } else {
        raw = c.message || c.job || JSON.stringify(c);
      }

      // 人类消息不渲染 markdown，但保留换行
      if (msg.from_agent === 'human') {
        return escapeHtml(raw).replace(/\n/g, '<br>');
      }

      // Agent 回复用 marked 渲染 markdown
      try {
        let html = marked.parse(raw, { breaks: true, gfm: true });
        
        // 🆕 检测 artifact URLs（/artifacts/*.html）并嵌入 iframe
        html = html.replace(
          /(<a [^>]*href=")(https?:\/\/[^"]*\/artifacts\/[^"]+\.html)("[^>]*>)(.*?)<\/a>/gi,
          function(match, pre, url, mid, text) {
            return `<div class="artifact-embed" style="margin:12px 0;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <span style="font-size:13px;color:#666;">📊 可视化</span>
                <a href="${url}" target="_blank" rel="noopener" style="font-size:12px;color:#4A90D9;">在新窗口打开 ↗</a>
              </div>
              <iframe src="${url}" sandbox="allow-scripts allow-same-origin" 
                style="width:100%;height:420px;border:1px solid #e0e0e0;border-radius:8px;background:#fff;"
                loading="lazy"></iframe>
            </div>`;
          }
        );
        
        // 也处理纯 URL 文本（未被 markdown 包装为链接的情况）
        html = html.replace(
          /(?<!href="|src=")(https?:\/\/[^\s<"]*\/artifacts\/[^\s<"]*\.html)/gi,
          function(url) {
            return `<div class="artifact-embed" style="margin:12px 0;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <span style="font-size:13px;color:#666;">📊 可视化</span>
                <a href="${url}" target="_blank" rel="noopener" style="font-size:12px;color:#4A90D9;">在新窗口打开 ↗</a>
              </div>
              <iframe src="${url}" sandbox="allow-scripts allow-same-origin"
                style="width:100%;height:420px;border:1px solid #e0e0e0;border-radius:8px;background:#fff;"
                loading="lazy"></iframe>
            </div>`;
          }
        );
        
        return html;
      } catch (e) {
        console.warn('Markdown render failed:', e);
        return escapeHtml(raw).replace(/\n/g, '<br>');
      }
    }

    // 聊天附件状态
    let chatPendingFiles = [];

    function onChatFileSelect(input) {
      chatPendingFiles = Array.from(input.files);
      const preview = document.getElementById('chat-file-preview');
      if (chatPendingFiles.length > 0) {
        preview.classList.remove('hidden');
        preview.innerHTML = chatPendingFiles.map((f, i) => 
          `<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full">${escapeHtml(f.name)}<button onclick="removeChatFile(${i})" class="text-blue-400 hover:text-red-500 ml-0.5">&times;</button></span>`
        ).join('');
      } else {
        preview.classList.add('hidden');
        preview.innerHTML = '';
      }
    }

    function removeChatFile(idx) {
      chatPendingFiles.splice(idx, 1);
      const preview = document.getElementById('chat-file-preview');
      if (chatPendingFiles.length === 0) {
        preview.classList.add('hidden');
        preview.innerHTML = '';
        document.getElementById('chat-file-input').value = '';
      } else {
        preview.innerHTML = chatPendingFiles.map((f, i) => 
          `<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded-full">${escapeHtml(f.name)}<button onclick="removeChatFile(${i})" class="text-blue-400 hover:text-red-500 ml-0.5">&times;</button></span>`
        ).join('');
      }
    }

    async function sendMessage() {
      if (!currentSpace || !currentSession) return alert('Select a session first');
      const input = document.getElementById('human-input');
      const job = input.value.trim();
      if (!job && chatPendingFiles.length === 0) return;
      
      try {
        // 先上传附件
        const uploadedFiles = [];
        for (const file of chatPendingFiles) {
          const res = await fetch(`${API_URL}/spaces/${currentSpace}/files/upload`, {
            method: 'POST',
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'X-Filename': file.name,
              'X-Uploaded-By': 'human',
            },
            body: file,
          });
          if (res.ok) {
            const data = await res.json();
            uploadedFiles.push({ file_id: data.file_id, filename: file.name, download_url: data.download_url });
          }
        }
        
        // 构建消息内容
        let jobText = job;
        if (uploadedFiles.length > 0) {
          const fileList = uploadedFiles.map(f => 
            `- 📎 ${f.filename} (file_id: ${f.file_id}, 下载: ${window.location.origin}${f.download_url}, 读取内容: ${API_URL}/spaces/${currentSpace}/files/${f.file_id}/content)`
          ).join('\n');
          jobText = jobText ? `${jobText}\n\n附件:\n${fileList}` : `附件:\n${fileList}`;
        }
        
        await fetch(`${API_URL}/spaces/${currentSpace}/sessions/${currentSession}/messages`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'human', type: 'human_job', content: { job: jobText } })
        });
        
        // 清理
        input.value = '';
        chatPendingFiles = [];
        const preview = document.getElementById('chat-file-preview');
        preview.classList.add('hidden');
        preview.innerHTML = '';
        const fileInput = document.getElementById('chat-file-input');
        if (fileInput) fileInput.value = '';
        
        await refreshMessages();
        const list = document.getElementById('messages-list');
        if (list) list.scrollTop = list.scrollHeight;
      } catch (err) { console.error('Send failed:', err); }
    }

    // ==================== Agents & Skills ====================

    function showJoinGuide() {
      if (!currentSpace) return;
      const spaceName = document.getElementById('space-name')?.textContent || currentSpace;
      const serverUrl = window.location.origin;
      const apiUrl = serverUrl + '/api';
      const skillUrl = serverUrl + '/api/skill';
      
      const text = `请帮我接入 Atheism 协作网络。

连接信息：
- Server: ${serverUrl}
- API: ${apiUrl}
- Space ID: ${currentSpace}
- Space 名称: ${spaceName}

接入步骤：

1. 阅读接入文档获取完整说明：
   ${skillUrl}
   用 web_fetch 工具抓取上面的 URL，里面有完整的安装和配置指南。

2. 安装 Plugin：
   curl -sL ${apiUrl}/plugin/install-script | bash

3. 在 ~/.openclaw/openclaw.json 中配置 a2aspace channel，spaceId 填 "${currentSpace}"。
   具体配置格式参考接入文档。

4. 配置完成后重启：openclaw gateway restart

5. 接入成功后，用以下 API 将自己加入 Space：
   curl -X POST ${apiUrl}/spaces/${currentSpace}/members -H "Content-Type: application/json" -d '{"agent_id": "你的agent_id"}'`;
      
      document.getElementById('guide-text').textContent = text;
      document.getElementById('join-guide-modal').classList.remove('hidden');
    }

    function copyGuideText(elementId) {
      const el = document.getElementById(elementId);
      if (!el) return;
      navigator.clipboard.writeText(el.textContent).then(() => {
        const btn = el.closest('.px-6')?.querySelector('[onclick*="copyGuideText"]') 
          || el.parentElement?.parentElement?.querySelector('button[onclick*="copy"]');
        if (btn) { const orig = btn.innerHTML; btn.innerHTML = '✅ 已复制'; setTimeout(() => btn.innerHTML = orig, 1500); }
      });
    }

    // ==================== Agent Control (Solo/Mute) ====================

    let agentControlState = []; // [{ agent_id, name, status, muted }]
    let soloActive = false;
    let soloAgentId = null;

    async function loadAgentControl() {
      if (!currentSpace || !currentSession) {
        document.getElementById('agent-control-bar').classList.add('hidden');
        return;
      }
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/sessions/${currentSession}/agent-config`);
        const data = await res.json();
        agentControlState = data.agents || [];
        soloActive = false;
        soloAgentId = null;
        renderAgentControl();
        document.getElementById('agent-control-bar').classList.remove('hidden');
      } catch (err) { console.error('Failed to load agent config:', err); }
    }

    function renderAgentControl() {
      const container = document.getElementById('agent-control-list');
      const activeCount = agentControlState.filter(a => !a.muted).length;
      
      container.innerHTML = agentControlState.map(a => {
        const isMuted = a.muted;
        const dotColor = a.status === 'online' ? (isMuted ? 'bg-gray-300' : 'bg-green-400') : 'bg-gray-300';
        const textClass = isMuted ? 'text-gray-300 line-through' : 'text-gray-700';
        const bgClass = isMuted ? 'bg-white border-gray-200' : 'bg-white border-blue-200';
        const title = isMuted ? `${a.name} (muted) - 点击启用` : `${a.name} - 点击静默`;
        return `<button onclick="toggleAgentMute('${a.agent_id}')" title="${title}" 
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${bgClass} hover:shadow-sm transition-all">
          <span class="w-1.5 h-1.5 rounded-full ${dotColor}"></span>
          <span class="${textClass}">${escapeHtml(a.name)}</span>
          ${isMuted ? '<span class="text-gray-300">🔇</span>' : ''}
        </button>`;
      }).join('');
      
      // Solo 按钮状态
      const soloBtn = document.getElementById('solo-btn');
      if (soloBtn) {
        if (soloActive) {
          soloBtn.classList.add('border-orange-400', 'text-orange-500', 'bg-orange-50');
          soloBtn.classList.remove('border-gray-300', 'text-gray-500');
          soloBtn.textContent = 'Solo ✦';
        } else {
          soloBtn.classList.remove('border-orange-400', 'text-orange-500', 'bg-orange-50');
          soloBtn.classList.add('border-gray-300', 'text-gray-500');
          soloBtn.textContent = 'Solo';
        }
      }
    }

    async function toggleAgentMute(agentId) {
      const agent = agentControlState.find(a => a.agent_id === agentId);
      if (!agent) return;
      
      // 如果是 solo 模式，切换到普通 mute 模式
      if (soloActive) {
        soloActive = false;
        soloAgentId = null;
      }
      
      agent.muted = !agent.muted;
      renderAgentControl();
      await saveAgentConfig();
    }

    async function soloMode() {
      if (soloActive) {
        // 取消 solo，恢复全部
        soloActive = false;
        soloAgentId = null;
        agentControlState.forEach(a => a.muted = false);
        renderAgentControl();
        await saveAgentConfig();
        return;
      }
      
      // 进入 solo 选择：弹出选择器
      const onlineAgents = agentControlState.filter(a => a.status === 'online');
      if (onlineAgents.length === 0) return alert('没有在线 Agent');
      
      const names = onlineAgents.map((a, i) => `${i + 1}. ${a.name}`).join('\n');
      const choice = prompt(`选择 Solo Agent（输入编号）:\n${names}`);
      if (!choice) return;
      
      const idx = parseInt(choice) - 1;
      if (idx < 0 || idx >= onlineAgents.length) return;
      
      const selected = onlineAgents[idx];
      soloActive = true;
      soloAgentId = selected.agent_id;
      agentControlState.forEach(a => {
        a.muted = a.agent_id !== selected.agent_id;
      });
      renderAgentControl();
      await saveAgentConfig();
    }

    async function unmuteAll() {
      soloActive = false;
      soloAgentId = null;
      agentControlState.forEach(a => a.muted = false);
      renderAgentControl();
      await saveAgentConfig();
    }

    async function saveAgentConfig() {
      if (!currentSpace || !currentSession) return;
      const muted = agentControlState.filter(a => a.muted).map(a => a.agent_id);
      try {
        await fetch(`${API_URL}/spaces/${currentSpace}/sessions/${currentSession}/agent-config`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ muted_agents: muted }),
        });
      } catch (err) { console.error('Failed to save agent config:', err); }
    }

    async function loadAgents() {
      if (!currentSpace) return;
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/agents`);
        const { agents } = await res.json();
        document.getElementById('agents-list').innerHTML = (!agents || agents.length === 0)
          ? '<div class="text-center text-gray-500 py-8 col-span-3">No agents registered</div>'
          : agents.map(a => `
            <div class="border border-gray-200/80 rounded-lg p-4 cursor-pointer hover:border-blue-400 bg-white card-hover" onclick="openAgentConfig('${a.agent_id}')">
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center space-x-2">
                  <span class="w-3 h-3 rounded-full ${a.status === 'online' ? 'bg-green-500 pulse-dot' : 'bg-gray-400'}"></span>
                  <h4 class="font-semibold">${escapeHtml(a.name)}</h4>
                </div>
                <span class="text-xs text-gray-400">⚙️</span>
              </div>
              <p class="text-xs text-gray-500 mb-2">${a.agent_id}</p>
              <div class="flex items-center justify-between">
                <div class="flex flex-wrap gap-1">
                  ${(a.capabilities || []).map(c => `<span class="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">${c}</span>`).join('')}
                </div>
                <span class="text-xs text-gray-400" title="Max concurrent tasks">🔄 ${a.max_concurrent || 3}</span>
              </div>
            </div>
          `).join('');
      } catch (err) { console.error('Failed to load agents:', err); }
    }

    // Agent 配置弹窗
    async function openAgentConfig(agentId) {
      if (!currentSpace) return;
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/agents/${agentId}`);
        const { agent } = await res.json();
        
        const maxC = agent.max_concurrent || 3;
        const modal = document.createElement('div');
        modal.id = 'agent-config-modal';
        modal.className = 'fixed inset-0 z-50 overflow-y-auto';
        modal.innerHTML = `
          <div class="fixed inset-0 bg-black bg-opacity-40" onclick="closeAgentConfig()"></div>
          <div class="flex items-center justify-center min-h-screen px-4">
            <div class="bg-white rounded-xl shadow-2xl max-w-md w-full relative z-10 overflow-hidden">
              <div class="px-6 py-4 border-b border-gray-200 bg-gray-50">
                <div class="flex items-center justify-between">
                  <h3 class="text-lg font-bold text-gray-900">🤖 Agent 配置</h3>
                  <button onclick="closeAgentConfig()" class="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
                </div>
              </div>
              <div class="px-6 py-5 space-y-4">
                <div>
                  <div class="flex items-center space-x-2 mb-1">
                    <span class="w-3 h-3 rounded-full ${agent.status === 'online' ? 'bg-green-500' : 'bg-gray-400'}"></span>
                    <span class="font-semibold text-gray-900">${escapeHtml(agent.name)}</span>
                  </div>
                  <p class="text-xs text-gray-500 font-mono">${agent.agent_id}</p>
                </div>
                
                <div>
                  <label class="text-sm font-medium text-gray-700 block mb-1">能力标签</label>
                  <div class="flex flex-wrap gap-1">
                    ${(agent.capabilities || []).map(c => `<span class="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">${c}</span>`).join('')}
                  </div>
                </div>

                <div>
                  <label class="text-sm font-medium text-gray-700 block mb-2">🔄 最大并发任务数</label>
                  <div class="flex items-center space-x-3">
                    <input type="range" id="agent-max-concurrent" min="1" max="10" value="${maxC}" 
                      class="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
                      oninput="document.getElementById('concurrent-value').textContent = this.value">
                    <span id="concurrent-value" class="text-lg font-bold text-blue-600 w-8 text-center">${maxC}</span>
                  </div>
                  <p class="text-xs text-gray-400 mt-1">同时处理不同 session 消息的最大数量（1-10）</p>
                </div>

                <div>
                  <label class="text-sm font-medium text-gray-700 block mb-1">最后心跳</label>
                  <p class="text-xs text-gray-500">${agent.last_heartbeat ? new Date(agent.last_heartbeat).toLocaleString('zh-CN') : '从未'}</p>
                </div>
              </div>
              <div class="px-6 py-3 border-t border-gray-200 bg-gray-50 flex justify-end space-x-2">
                <button onclick="closeAgentConfig()" class="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">取消</button>
                <button onclick="saveAgentConcurrentConfig('${agent.agent_id}')" class="bg-blue-500 hover:bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg font-medium">保存</button>
              </div>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
      } catch (err) { console.error('Failed to load agent:', err); }
    }

    function closeAgentConfig() {
      const modal = document.getElementById('agent-config-modal');
      if (modal) modal.remove();
    }

    async function saveAgentConcurrentConfig(agentId) {
      const maxConcurrent = parseInt(document.getElementById('agent-max-concurrent')?.value || '3');
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/agents/${agentId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_concurrent: maxConcurrent }),
        });
        if (res.ok) {
          closeAgentConfig();
          loadAgents();
        }
      } catch (err) { console.error('Failed to save agent config:', err); }
    }

    async function loadSkills() {
      if (!currentSpace) return;
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/skills`);
        const { skills } = await res.json();
        document.getElementById('skills-list').innerHTML = (!skills || skills.length === 0)
          ? '<div class="text-center text-gray-500 py-8 col-span-3">No skills shared</div>'
          : skills.map(s => `
            <div class="border border-gray-200/80 rounded-lg p-4 cursor-pointer hover:border-blue-300 bg-white card-hover" onclick="openSkillModal('${s.skill_id}', '${escapeHtml(s.name)}', 'v${s.version}')">
              <h4 class="font-semibold">${escapeHtml(s.name)} <span class="text-xs text-gray-500">v${s.version}</span></h4>
              <p class="text-sm text-gray-600 mt-1">${escapeHtml(s.description || '')}</p>
              ${(s.tags && s.tags.length > 0) ? `<div class="flex flex-wrap gap-1 mt-2">${s.tags.map(t => `<span class="inline-block px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
              <div class="flex items-center space-x-4 mt-2 text-sm">
                <span class="text-green-600">Fitness: ${Math.round((s.fitness_score || 0) * 100)}%</span>
                <span class="text-gray-500">${s.usage_count || 0} uses</span>
              </div>
            </div>
          `).join('');
      } catch (err) { console.error('Failed to load skills:', err); }
    }

    // ==================== Files ====================

    async function loadFiles() {
      if (!currentSpace) return;
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/files`);
        const { files } = await res.json();
        const container = document.getElementById('files-list');
        if (!files || files.length === 0) {
          container.innerHTML = '<div class="text-center text-gray-500 py-8">No files shared yet</div>';
          return;
        }
        container.innerHTML = `
          <div class="divide-y divide-gray-100">
            ${files.map(f => {
              const size = f.size < 1024 ? `${f.size} B` 
                : f.size < 1048576 ? `${(f.size/1024).toFixed(1)} KB` 
                : `${(f.size/1048576).toFixed(1)} MB`;
              const time = new Date(f.created_at).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
              const icon = getFileIcon(f.filename);
              return `
                <div class="flex items-center justify-between py-3 px-2 hover:bg-gray-50 rounded-lg group">
                  <div class="flex items-center gap-3 min-w-0">
                    <span class="text-xl shrink-0">${icon}</span>
                    <div class="min-w-0">
                      <div class="font-medium text-sm text-gray-900 truncate">${escapeHtml(f.filename)}</div>
                      <div class="text-xs text-gray-500">${size} · ${escapeHtml(f.uploaded_by)} · ${time}${f.description ? ' · ' + escapeHtml(f.description) : ''}</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <a href="${API_URL}/spaces/${currentSpace}/files/${f.file_id}/download" class="px-2 py-1 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100">下载</a>
                    <button onclick="deleteFile('${f.file_id}','${escapeHtml(f.filename)}')" class="px-2 py-1 text-xs bg-red-50 text-red-500 rounded hover:bg-red-100">删除</button>
                  </div>
                </div>`;
            }).join('')}
          </div>`;
      } catch (err) { console.error('Failed to load files:', err); }
    }

    function getFileIcon(filename) {
      const ext = (filename.split('.').pop() || '').toLowerCase();
      const icons = {
        pdf: '📄', doc: '📝', docx: '📝', txt: '📝', md: '📝',
        png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
        mp4: '🎬', mov: '🎬', avi: '🎬', mp3: '🎵', wav: '🎵',
        zip: '📦', tar: '📦', gz: '📦', rar: '📦',
        py: '🐍', js: '📜', ts: '📜', json: '📋', yaml: '📋', yml: '📋',
        html: '🌐', css: '🎨', csv: '📊', xlsx: '📊', xls: '📊',
      };
      return icons[ext] || '📎';
    }

    async function uploadFile(input) {
      if (!currentSpace || !input.files.length) return;
      for (const file of input.files) {
        try {
          const res = await fetch(`${API_URL}/spaces/${currentSpace}/files/upload`, {
            method: 'POST',
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'X-Filename': file.name,
              'X-Uploaded-By': 'human',
            },
            body: file,
          });
          if (!res.ok) throw new Error(await res.text());
        } catch (err) { alert(`上传失败: ${file.name}\n${err.message}`); }
      }
      input.value = '';
      loadFiles();
    }

    async function deleteFile(fileId, filename) {
      if (!confirm(`删除文件 "${filename}"？`)) return;
      try {
        await fetch(`${API_URL}/spaces/${currentSpace}/files/${fileId}`, { method: 'DELETE' });
        loadFiles();
      } catch (err) { console.error('Delete failed:', err); }
    }

    // ==================== Skills ====================

    async function openSkillModal(skillId, name, version) {
      // 创建或复用弹窗
      let modal = document.getElementById('skill-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'skill-modal';
        modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40';
        modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
        modal.innerHTML = `
          <div class="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col">
            <div class="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 rounded-t-2xl flex items-center justify-between shrink-0">
              <h3 id="skill-modal-title" class="text-lg font-bold text-gray-900"></h3>
              <button onclick="document.getElementById('skill-modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
            </div>
            <div id="skill-modal-body" class="px-6 py-4 overflow-y-auto"></div>
          </div>`;
        document.body.appendChild(modal);
      }
      
      document.getElementById('skill-modal-title').textContent = `${name} ${version}`;
      document.getElementById('skill-modal-body').innerHTML = '<div class="text-gray-400 text-sm py-8 text-center">加载中...</div>';
      modal.classList.remove('hidden');
      
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/skills/${skillId}/download`);
        const md = await res.text();
        document.getElementById('skill-modal-body').innerHTML = '<div class="prose prose-sm max-w-none text-sm">' + simpleMarkdown(md) + '</div>';
      } catch (err) {
        document.getElementById('skill-modal-body').innerHTML = '<div class="text-red-500 text-sm py-8 text-center">加载失败</div>';
      }
    }

    function simpleMarkdown(md) {
      // Escape HTML first to prevent XSS
      var e = function(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
      md = e(md);
      return md
        // Code blocks (match escaped backticks)
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-gray-100 rounded p-3 overflow-x-auto text-xs my-2"><code>$2</code></pre>')
        // Tables
        .replace(/\n\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)*)/g, (m, header, body) => {
          const ths = header.split('|').map(h => `<th class="px-2 py-1 border text-left text-xs">${h.trim()}</th>`).join('');
          const rows = body.trim().split('\n').map(row => {
            const tds = row.replace(/^\||\|$/g, '').split('|').map(c => `<td class="px-2 py-1 border text-xs">${c.trim()}</td>`).join('');
            return `<tr>${tds}</tr>`;
          }).join('');
          return `<table class="border-collapse border my-2 w-full"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
        })
        // Headers
        .replace(/^### (.+)$/gm, '<h4 class="font-bold text-sm mt-3 mb-1">$1</h4>')
        .replace(/^## (.+)$/gm, '<h3 class="font-bold text-base mt-4 mb-1">$1</h3>')
        .replace(/^# (.+)$/gm, '<h2 class="font-bold text-lg mt-4 mb-2">$1</h2>')
        // Bold
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // Inline code
        .replace(/`([^`]+)`/g, '<code class="bg-gray-100 px-1 rounded text-xs">$1</code>')
        // List items
        .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-sm">$1</li>')
        .replace(/^(\d+)\. (.+)$/gm, '<li class="ml-4 list-decimal text-sm">$2</li>')
        // Line breaks
        .replace(/\n\n/g, '<br/><br/>')
        .replace(/\n/g, '<br/>');
    }

    // ==================== Guide Modal ====================

    function openGuide() {
      document.getElementById('guide-modal').classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    }
    function closeGuide() {
      document.getElementById('guide-modal').classList.add('hidden');
      document.body.style.overflow = '';
    }
    // ESC to close
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !document.getElementById('guide-modal').classList.contains('hidden')) closeGuide();
    });

    // ==================== System Prompt ====================

    const BUILTIN_RULES = `You are participating in an Atheism multi-agent collaboration session.

## Collaboration Rules
- You can see ALL messages in this session: from humans AND from other AI agents.
- Human messages: Always respond helpfully.
- Agent messages: Only respond if you have something genuinely valuable to add (new information, a correction, a different perspective). If the other agent already handled it well, stay silent.
- To stay silent: Reply with exactly NO_REPLY as your entire response.
- Never respond to your own previous messages.
- Be concise. Avoid repeating what other agents already said.

## When to respond to other agents
✅ You have new information they don't
✅ They made a mistake you can correct
✅ The human asked for multiple opinions
✅ You can build on their answer meaningfully

## When to stay silent (NO_REPLY)
❌ The other agent already answered well
❌ You'd just be saying "I agree" or paraphrasing
❌ The conversation doesn't need your input
❌ You're not sure you can add value`;

    let systemPromptExpanded = false;

    function toggleSystemPrompt() {
      systemPromptExpanded = !systemPromptExpanded;
      document.getElementById('system-prompt-body').classList.toggle('hidden', !systemPromptExpanded);
      document.getElementById('prompt-toggle-icon').textContent = systemPromptExpanded ? '▼' : '▶';
    }

    async function loadSystemPrompt() {
      if (!currentSpace) return;
      // 显示面板
      document.getElementById('system-prompt-panel').classList.remove('hidden');
      // 填充内置规则
      document.getElementById('builtin-rules').textContent = BUILTIN_RULES;
      // 加载自定义规则
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/system-prompt`);
        const { custom_rules, updated_at } = await res.json();
        document.getElementById('custom-rules-input').value = custom_rules || '';
        if (updated_at) {
          document.getElementById('prompt-save-status').textContent = `Last saved: ${formatTime(updated_at)}`;
        }
      } catch (err) {
        console.error('Failed to load system prompt:', err);
      }
    }

    async function saveCustomRules() {
      if (!currentSpace) return;
      const rules = document.getElementById('custom-rules-input').value;
      const statusEl = document.getElementById('prompt-save-status');
      statusEl.textContent = 'Saving...';
      statusEl.classList.remove('text-green-500', 'text-red-500');
      statusEl.classList.add('text-gray-400');
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/system-prompt`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ custom_rules: rules }),
        });
        if (res.ok) {
          statusEl.textContent = '✅ Saved';
          statusEl.classList.remove('text-gray-400');
          statusEl.classList.add('text-green-500');
        } else {
          statusEl.textContent = '❌ Save failed';
          statusEl.classList.add('text-red-500');
        }
      } catch (err) {
        statusEl.textContent = '❌ Network error';
        statusEl.classList.add('text-red-500');
      }
      setTimeout(() => {
        statusEl.textContent = `Last saved: ${formatTime(new Date().toISOString())}`;
        statusEl.classList.remove('text-green-500', 'text-red-500');
        statusEl.classList.add('text-gray-400');
      }, 2000);
    }

    // ==================== Session Summary ====================
    
    let summaryPanelOpen = false;
    
    function toggleSummaryPanel() {
      summaryPanelOpen = !summaryPanelOpen;
      const panel = document.getElementById('summary-panel');
      if (panel) {
        panel.classList.toggle('hidden', !summaryPanelOpen);
        if (summaryPanelOpen) refreshSummary();
      }
    }
    
    async function refreshSummary() {
      if (!currentSpace || !currentSession) return;
      try {
        const res = await fetch(`${API_URL}/spaces/${currentSpace}/sessions/${currentSession}/summary`);
        const { summary } = await res.json();
        const content = document.getElementById('summary-content');
        const meta = document.getElementById('summary-meta');
        if (!content) return;
        
        if (summary && summary.summary_text) {
          content.innerHTML = marked.parse(summary.summary_text);
          if (meta) {
            const agent = summary.updated_by || '?';
            const time = formatTime(summary.updated_at);
            meta.textContent = `by ${agent} · ${time}`;
          }
          // Server handles title extraction during summary PUT — no client-side override needed
        } else {
          content.innerHTML = '<span class="text-gray-400">No summary yet. Summary is auto-generated after 10+ messages.</span>';
          if (meta) meta.textContent = '';
        }
      } catch (err) {
        console.error('Failed to fetch summary:', err);
      }
    }
    
    // Auto-refresh summary during polling
    let lastSummaryRefresh = 0;
    const originalPollUpdate = typeof pollUpdate === 'function' ? pollUpdate : null;

    // ==================== Utils ====================

    function escapeHtml(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
    function formatTime(ts) {
      if (!ts) return '';
      const diff = (Date.now() - new Date(ts)) / 60000;
      if (diff < 1) return 'now';
      if (diff < 60) return Math.floor(diff) + 'm';
      if (diff < 1440) return Math.floor(diff / 60) + 'h';
      return new Date(ts).toLocaleDateString();
    }

    // Init
    loadSpaces().then(() => {
      // 从 URL hash 恢复路由
      const { spaceId } = parseHash();
      if (spaceId) routeFromHash();
    });

    // Auto-close empty sessions when user leaves page
    let currentSessionMsgCount = 0;
    const origSelectSession = selectSession;
    // Track message count on session select
    const origLoadMessages = loadMessages;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') cleanupEmptySession();
    });
    window.addEventListener('beforeunload', () => cleanupEmptySession());

    function cleanupEmptySession() {
      if (!currentSpace || !currentSession) return;
      // Check if session info shows 0 messages
      const infoEl = document.getElementById('session-info');
      const msgText = infoEl?.textContent || '';
      const msgCount = parseInt(msgText) || 0;
      if (msgCount === 0) {
        // Fire-and-forget archive
        navigator.sendBeacon(
          `${API_URL}/spaces/${currentSpace}/sessions/${currentSession}/cleanup`,
          JSON.stringify({ action: 'archive_if_empty' })
        );
      }
    }